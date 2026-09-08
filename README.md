# LinkedIn Location Enricher

Give it a CSV containing LinkedIn URLs. Get back the same CSV with location
columns filled in.

Built for the case where a CRM (Attio, Airtable, HubSpot…) has companies whose
`Location` field is empty or garbage, and you need to answer a question like
*"which of these did we see in the south of France?"*

Works with both **company pages** (`/company/…`) and **person profiles** (`/in/…`).

---

## Output

Your original columns, untouched, plus five new ones:

| Column | Example | Notes |
|---|---|---|
| `LinkedIn Location` | `Toulouse, Occitanie, France` | Raw string as LinkedIn shows it |
| `City` | `Toulouse` | First segment |
| `Region` | `Occitanie` | Middle segment(s), blank if LinkedIn only gave two |
| `Country` | `France` | Last segment |
| `Enrich Status` | `ok` | See status table below |

| Status | Meaning |
|---|---|
| `ok` | Location found |
| `not_found` | Page loaded, but no location on it (common — plenty of companies leave it blank) |
| `skipped_no_url` | That row had no usable LinkedIn URL |
| `login_required` | LinkedIn showed a login wall — run pauses so you can log in |
| `error_no_response` | Page didn't respond in time; re-run those rows |

---

## Why it drives a real browser tab instead of just fetching the URL

This is the part worth knowing before anyone tries to "simplify" it.

**LinkedIn serves an empty shell to plain HTTP requests.** Fetching a profile
URL server-side — `curl`, `requests`, `fetch()` from a background script, even
*with* valid session cookies — returns roughly 400KB of JavaScript bootstrap
containing **zero** profile data. No name, no location, nothing. All the content
is injected client-side after the SPA hydrates.

That was measured, not assumed: a background `fetch()` with `credentials:
'include'` on a logged-in session returned 397KB with 0 matching DOM elements
and the word "experience" appearing 0 times.

So the only thing that works is: **load the page in a real logged-in tab, let it
render, then read the DOM.** That's what this extension does, and it's why it
can't be a standalone Python script.

Second thing worth knowing: **LinkedIn unmounts profile sections that scroll out
of the viewport** (virtual scrolling). Location happens to live in the top card,
which is visible on load — that's why this tool works without scrolling. Data
lower down the page (experience, education) would need scroll handling.

---

## Install

1. Download / clone this folder.
2. Chrome → `chrome://extensions/`
3. Turn on **Developer mode** (top right).
4. **Load unpacked** → select this folder.
5. Pin the extension so you can reach the popup.

No API keys, no accounts, no config. It uses whatever LinkedIn session is
already in your browser.

---

## Use

1. **Log in to LinkedIn** in the same Chrome profile.
2. Click the extension icon.
3. **Upload your CSV.** It auto-detects the URL column (by header name, or by
   sniffing which column contains `linkedin.com` links) and the delimiter
   (`,` or `;` — French Excel exports use `;`).
4. Set the **delay** between profiles. Default 10s, randomised ±40%.
5. **Start.** A background tab opens and walks the list. You can keep working
   in other tabs; just don't close that one.
6. **Download CSV** when it finishes.

Pause and resume any time. Progress is saved after every single row, so closing
the popup — or Chrome killing the background worker — doesn't lose work. Press
Resume and it picks up from where it stopped.

### CSV format

Anything with a column of LinkedIn URLs. A header row is required.

```csv
Company,LinkedIn URL,Notes
Example Co,https://www.linkedin.com/company/example-co/,seen at demo day
Jane Founder,https://www.linkedin.com/in/janefounder/,person profile works too
```

Naming the column `LinkedIn URL` (or anything containing "linkedin", "profile",
"url", "lien") makes detection certain. See `sample-input.csv`.

---

## Volume: don't be greedy

LinkedIn watches for behavioural anomalies, and the account at risk is yours.

- Default 10s delay ≈ **~350/hour** in theory. Don't run it for an hour.
- Sensible ceiling: **a few hundred profile views per day**, including your
  normal browsing. Reports of accounts getting restricted cluster around the
  500–1000/day mark.
- If you have thousands of rows, split across several days, or accept that
  buying the data (Societe.com / Pappers for French companies, Clay, Apollo)
  is the boring correct answer for that volume.
- The randomised delay exists because a metronomic 10.000s cadence is itself a
  fingerprint.

**For French companies specifically:** if you need legal HQ rather than
whatever someone typed on a LinkedIn page, [Pappers](https://www.pappers.fr/)
and [annuaire-entreprises.data.gouv.fr](https://annuaire-entreprises.data.gouv.fr/)
expose registry data (SIREN → address) via free/cheap APIs and won't get your
account limited. That's genuinely better data for "is this company in the south
of France" than a self-reported LinkedIn field. Use LinkedIn for the rows where
you don't have a company name good enough to match a registry.

---

## Bonus: filtering to the south of France

Once you have the CSV back, do this in the spreadsheet rather than in code —
easier to eyeball and correct.

Flag rows in the three southern regions:

```
=IF(OR(
   REGEXMATCH(LOWER(C2&" "&D2), "occitanie|provence|alpes-côte|alpes-cote|paca|nouvelle-aquitaine|corse"),
   REGEXMATCH(LOWER(C2), "toulouse|montpellier|marseille|nice|aix-en-provence|bordeaux|perpignan|nîmes|nimes|avignon|toulon|béziers|beziers|pau|bayonne|cannes|antibes|narbonne|carcassonne|albi|tarbes|sète|sete|arles|salon-de-provence|martigues|aubagne|La Ciotat|Biarritz|Agen|Rodez|Millau|Ajaccio|Bastia")
 ), "SOUTH", "")
```

Adjust `C2`/`D2` to wherever `City` and `Region` land in your sheet.

Two caveats: Bordeaux/Nouvelle-Aquitaine is south-**west** and may or may not
count depending on the LP's definition — decide that before you filter. And
LinkedIn frequently gives blobs like `Greater Toulouse Metropolitan Area`
instead of a clean `City, Region, Country`, which is why the regex checks both
the city and region columns.

---

## When it stops working

LinkedIn ships DOM changes constantly. When the location stops being found,
the selector needs updating — this is normal maintenance, not a broken tool.

**Person profiles** are the stable one. The extractor anchors on the
`Contact info` link and takes the first `<p>` in its container:

```js
document.querySelector('main a[href*="/overlay/contact-info"]')
```

**Company pages** are the fragile one. Three strategies run in order:
`<dt>Headquarters</dt>` in the About tab, then the dot-separated meta line in
the top card, then a generic label-then-sibling walk. Company URLs are
auto-rewritten to `/about/` because that page carries the data most reliably.

### Finding the new selector

1. Tick **Verbose** in the popup before starting.
2. Open the tab the extension is driving, open DevTools → Console.
3. Look for the `[Enricher] debug dump` group. It prints the contact-info
   anchor plus the first 60 short text nodes inside `<main>`.
4. Find your location string in that list, then inspect that element to get a
   stable attribute.
5. Edit the matching function in `content.js` (`extractPersonLocation` or
   `extractCompanyLocation`), reload the extension.

Prefer, in this order: `data-*` attributes → structural relationships
(`closest`, `nextElementSibling`) → visible text anchors → class names. Never
rely on LinkedIn's CSS class names; they're generated hashes like `_13ea86fc`
that change on every deploy.

---

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Permissions: storage, tabs, alarms; host access to linkedin.com only. |
| `popup.html` / `popup.js` | UI. CSV parse/serialise, progress polling, download. |
| `background.js` | Orchestrator. Owns the queue, drives the tab, persists state, recovers from service-worker death. |
| `content.js` | Extraction. Runs on LinkedIn pages, answers `EXTRACT_LOCATION`, detects auth walls. |
| `sample-input.csv` | Example input format. |

### Implementation notes

- **State is persisted after every row** (`chrome.storage.local`), so nothing is
  lost if Chrome kills the background worker mid-run.
- **Two keep-alive mechanisms**, because MV3 workers die after ~30s idle: the
  content script holds an open port and pings every 20s, and a 30s alarm
  restarts the loop if it detects the worker restarted mid-run. The alarm is the
  reliable one — timers in a backgrounded tab get throttled.
- **Login walls hard-stop the run** rather than recording hundreds of blanks.
  Log in in the open tab, press Resume.
- No analytics, no external calls. Only linkedin.com is contacted.

---

## Limitations

- Only reads what LinkedIn publicly renders to your account. Restricted profiles
  give less.
- `not_found` is often correct, not a bug — many companies simply don't fill in
  a location.
- One tab, sequential. Parallelising would be faster and would get you
  rate-limited faster.
- Company location is self-reported and often the "HQ" of a subsidiary or a
  registered address that isn't where the team sits. For French legal HQ, use
  the registry (see above).

## License

Do what you like with it. No warranty.
