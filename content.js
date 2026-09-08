// Runs on every linkedin.com page. Inert until the background script asks it
// to extract a location. Wrapped in an IIFE so top-level consts can't collide
// with any other extension's content script sharing this isolated world.
(() => {

  // ─── Page-type detection ────────────────────────────────────────────────────

  function detectPageType() {
    const p = window.location.pathname;
    if (/^\/in\//.test(p)) return 'person';
    if (/^\/company\//.test(p)) return 'company';
    if (/^\/school\//.test(p)) return 'company'; // same layout family
    return 'unknown';
  }

  // Detect the login/auth wall. LinkedIn bounces logged-out requests to
  // /login, /authwall, or /checkpoint. If we're there, the run should stop
  // rather than silently recording hundreds of blanks.
  function isAuthWall() {
    const p = window.location.pathname;
    if (/^\/(login|authwall|checkpoint|uas)/.test(p)) return true;
    // Some auth walls keep the URL but render a join/sign-in form.
    if (document.querySelector('form[action*="/checkpoint/"]')) return true;
    return false;
  }

  // ─── Person profile: location ───────────────────────────────────────────────
  // Verified against LinkedIn's 2025+ "SDUI" profile layout.
  //
  // Structure of the top card:
  //   <div>
  //     <p>Munich, Bavaria, Germany</p>     <- location (what we want)
  //     <p>·</p>
  //     <p><a href="…/overlay/contact-info/">Contact info</a></p>
  //   </div>
  //
  // Anchor on the contact-info link (href match is locale-independent), then
  // take the first <p> in its container.

  function extractPersonLocation() {
    let contactLink = document.querySelector('main a[href*="/overlay/contact-info"]');

    // Fallback: match on visible text if the href pattern changes.
    if (!contactLink) {
      const LABELS = ['contact info', 'coordonnées', 'contact', 'kontaktinfo', 'información de contacto'];
      contactLink = Array.from(document.querySelectorAll('main a')).find((a) =>
        LABELS.includes((a.innerText || '').trim().toLowerCase())
      );
    }
    if (!contactLink) return '';

    const container = contactLink.closest('div');
    if (!container) return '';

    const firstP = container.querySelector('p');
    return firstP ? (firstP.innerText || '').trim() : '';
  }

  // ─── Company page: headquarters ─────────────────────────────────────────────
  // Company DOM is less stable than the person top card, so we try several
  // strategies in order and return the first plausible hit.

  const HQ_LABELS = [
    'headquarters', 'siège social', 'siege social', 'hauptsitz',
    'sede', 'sede central', 'hoofdkantoor',
  ];

  function looksLikeLocation(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < 2 || t.length > 120) return false;
    // Reject obvious non-locations that share the same visual row.
    if (/followers|abonnés|employees|employés|salariés|see all|voir tout/i.test(t)) return false;
    if (/^\d[\d\s,.]*$/.test(t)) return false; // pure numbers
    return true;
  }

  function extractCompanyLocation() {
    // Strategy 1 — the About tab's definition list:
    //   <dt>Headquarters</dt><dd>Paris, Île-de-France</dd>
    const dts = Array.from(document.querySelectorAll('dt, h3, .text-heading-medium'));
    for (const dt of dts) {
      const label = (dt.innerText || '').trim().toLowerCase();
      if (!HQ_LABELS.some((l) => label.startsWith(l))) continue;
      // The value is usually the next sibling, or the next dd in the list.
      let candidate = dt.nextElementSibling;
      if (candidate && looksLikeLocation(candidate.innerText)) {
        return candidate.innerText.trim();
      }
      const dd = dt.parentElement && dt.parentElement.querySelector('dd');
      if (dd && looksLikeLocation(dd.innerText)) return dd.innerText.trim();
    }

    // Strategy 2 — the top card's dot-separated meta line:
    //   "Software Development · Paris, Île-de-France · 12,345 followers"
    // Take the middle segment(s) and pick the first that looks like a place.
    const metaCandidates = Array.from(
      document.querySelectorAll('main .org-top-card-summary-info-list, main .org-top-card-summary__info-item, main [class*="top-card"] div, main [class*="top-card"] p')
    );
    for (const el of metaCandidates) {
      const raw = (el.innerText || '').trim();
      if (!raw.includes('·')) continue;
      const parts = raw.split('·').map((s) => s.trim()).filter(Boolean);
      // Skip the first (industry) and last (followers) segments.
      for (let i = 1; i < parts.length; i++) {
        if (/followers|abonnés/i.test(parts[i])) continue;
        if (looksLikeLocation(parts[i]) && /[,\s]/.test(parts[i])) return parts[i];
      }
    }

    // Strategy 3 — any element whose text is exactly a HQ label, then walk to
    // the nearest following text node with plausible content.
    const all = Array.from(document.querySelectorAll('main *'));
    for (const el of all) {
      if (el.children.length > 0) continue; // leaf nodes only
      const label = (el.innerText || '').trim().toLowerCase();
      if (!HQ_LABELS.includes(label)) continue;
      let sib = el.parentElement ? el.parentElement.nextElementSibling : null;
      if (sib && looksLikeLocation(sib.innerText)) return sib.innerText.trim();
      sib = el.nextElementSibling;
      if (sib && looksLikeLocation(sib.innerText)) return sib.innerText.trim();
    }

    return '';
  }

  // ─── Debug dump ─────────────────────────────────────────────────────────────
  // When LinkedIn changes its DOM (it will), run the extension with "verbose"
  // enabled and read these logs to find the new selector.

  function debugDump(pageType) {
    console.groupCollapsed('[Enricher] debug dump — ' + pageType + ' — ' + location.pathname);
    console.log('contact-info anchor:', document.querySelector('main a[href*="/overlay/contact-info"]'));
    const leafTexts = Array.from(document.querySelectorAll('main p, main dd, main dt, main span'))
      .filter((el) => el.children.length === 0)
      .map((el) => (el.innerText || '').trim())
      .filter((t) => t && t.length < 100)
      .slice(0, 60);
    console.log('first 60 short leaf texts in <main>:', leafTexts);
    console.groupEnd();
  }

  // ─── Message handler ────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'EXTRACT_LOCATION') return false;

    const pageType = detectPageType();

    if (isAuthWall()) {
      sendResponse({ ok: false, status: 'login_required', pageType });
      return true;
    }

    if (msg.verbose) debugDump(pageType);

    let location = '';
    if (pageType === 'person') location = extractPersonLocation();
    else if (pageType === 'company') location = extractCompanyLocation();

    sendResponse({
      ok: true,
      status: location ? 'ok' : 'not_found',
      location,
      pageType,
      finalUrl: window.location.href,
    });
    return true;
  });

  // ─── Keep-alive ─────────────────────────────────────────────────────────────
  // MV3 kills an idle service worker after ~30s. During a long run we need the
  // background orchestrator alive. An open port plus periodic pings resets its
  // idle timer. (The background script ALSO has an alarms-based heartbeat that
  // resumes the queue if the worker dies anyway — belt and braces, because
  // timers in a backgrounded tab get throttled.)
  try {
    const port = chrome.runtime.connect({ name: 'keepalive' });
    setInterval(() => {
      try { port.postMessage({ t: Date.now() }); } catch (_) { /* port closed */ }
    }, 20000);
  } catch (_) {
    // connect() throws if the background isn't up yet; harmless.
  }

})();
