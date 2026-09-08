// ─── Orchestrator ─────────────────────────────────────────────────────────────
//
// Drives one browser tab through a list of LinkedIn URLs, asking the content
// script to read the location off each rendered page.
//
// WHY A REAL TAB AND NOT fetch():
//   LinkedIn serves an empty Ember/React shell to plain HTTP requests. Fetching
//   a profile URL from the service worker returns ~400KB of JavaScript
//   bootstrap with ZERO profile data in it — no name, no location, nothing.
//   The data only exists after the SPA hydrates in a real, logged-in tab.
//   Every "scrape LinkedIn with fetch/curl/requests" approach dies on this.
//
// SERVICE WORKER DEATH:
//   MV3 kills idle workers after ~30s. A long run with 10s delays would die
//   mid-queue. Two defences:
//     1. The content script holds an open port and pings every 20s.
//     2. An alarms heartbeat every 30s checks whether the queue should be
//        running but isn't (i.e. the worker restarted) and resumes it.
//   State is persisted after every single item, so resume is always safe.

const STORAGE_KEY = 'enricher_state';
const HEARTBEAT_ALARM = 'enricher_heartbeat';

// In-memory flag. Resets to false when the service worker restarts, which is
// exactly how the heartbeat detects that it needs to resume the loop.
let loopActive = false;

// ─── State ────────────────────────────────────────────────────────────────────

function blankState() {
  return {
    status: 'idle',        // idle | running | paused | done
    headers: [],           // original CSV header row
    rows: [],              // original CSV data rows
    urlColIndex: -1,       // which column holds the LinkedIn URL
    delimiter: ',',        // detected delimiter, reused on export
    results: [],           // parallel to rows: { location, city, region, country, status }
    cursor: 0,             // index of the next row to process
    tabId: null,
    delayMs: 10000,
    verbose: false,
    lastError: '',
    startedAt: null,
  };
}

async function loadState() {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  return got[STORAGE_KEY] || blankState();
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Randomise the gap between page loads. A perfectly regular 10.000s cadence is
// a machine fingerprint; humans are jittery.
function jitter(baseMs) {
  const factor = 0.6 + Math.random() * 0.8; // 60%–140% of base
  return Math.round(baseMs * factor);
}

// Company pages hide the HQ on the main tab but expose it reliably on /about/.
// Normalise so we land on the page that actually has the data.
function normaliseUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
  try {
    const u = new URL(url);
    if (!/linkedin\.com$/i.test(u.hostname.replace(/^www\./, ''))) return url;
    u.search = '';
    u.hash = '';
    if (/^\/company\//.test(u.pathname) || /^\/school\//.test(u.pathname)) {
      if (!/\/about\/?$/.test(u.pathname)) {
        u.pathname = u.pathname.replace(/\/+$/, '') + '/about/';
      }
    }
    return u.toString();
  } catch (_) {
    return url;
  }
}

// Split "Paris, Île-de-France, France" into parts. LinkedIn is inconsistent:
// sometimes 3 segments, sometimes 2, sometimes a blob like "Greater Paris
// Metropolitan Region". We always keep the raw string and make a best effort
// at the pieces.
function splitLocation(raw) {
  const s = String(raw || '').trim();
  if (!s) return { city: '', region: '', country: '' };
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) {
    return { city: parts[0], region: parts.slice(1, -1).join(', '), country: parts[parts.length - 1] };
  }
  if (parts.length === 2) return { city: parts[0], region: '', country: parts[1] };
  return { city: parts[0], region: '', country: '' };
}

// Wait for a tab to finish loading, with a hard timeout so a hung page can't
// stall the whole queue.
function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// The content script may not be ready the instant the tab reports "complete".
// Retry a few times before giving up.
async function askContentScript(tabId, verbose, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_LOCATION', verbose });
    } catch (_) {
      await sleep(700);
    }
  }
  return null;
}

async function ensureTab(state) {
  if (state.tabId != null) {
    try {
      await chrome.tabs.get(state.tabId);
      return state.tabId;
    } catch (_) {
      state.tabId = null; // tab was closed
    }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  state.tabId = tab.id;
  return tab.id;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function runLoop() {
  if (loopActive) return;
  loopActive = true;

  try {
    while (true) {
      const state = await loadState();
      if (state.status !== 'running') break;
      if (state.cursor >= state.rows.length) {
        state.status = 'done';
        await saveState(state);
        break;
      }

      const row = state.rows[state.cursor];
      const rawUrl = row[state.urlColIndex];
      const url = normaliseUrl(rawUrl);

      // Skip rows with no usable URL rather than burning a page load on them.
      if (!url || !/linkedin\.com\//i.test(url)) {
        state.results[state.cursor] = { location: '', city: '', region: '', country: '', status: 'skipped_no_url' };
        state.cursor += 1;
        await saveState(state);
        continue;
      }

      let tabId;
      try {
        tabId = await ensureTab(state);
      } catch (err) {
        state.status = 'paused';
        state.lastError = 'Could not open a tab: ' + err.message;
        await saveState(state);
        break;
      }

      await chrome.tabs.update(tabId, { url });
      const loaded = await waitForTabLoad(tabId);

      // LinkedIn hydrates after the load event; give the SPA a moment.
      await sleep(loaded ? 2500 : 1200);

      const resp = await askContentScript(tabId, state.verbose);

      // Re-read state: the user may have paused while we were waiting.
      const fresh = await loadState();
      if (fresh.status !== 'running') { loopActive = false; return; }
      fresh.tabId = tabId;

      if (!resp) {
        fresh.results[fresh.cursor] = { location: '', city: '', region: '', country: '', status: 'error_no_response' };
      } else if (resp.status === 'login_required') {
        // Hard stop: every subsequent row would fail the same way.
        fresh.results[fresh.cursor] = { location: '', city: '', region: '', country: '', status: 'login_required' };
        fresh.status = 'paused';
        fresh.lastError = 'LinkedIn showed a login wall. Log in in that tab, then press Resume.';
        await saveState(fresh);
        break;
      } else {
        const parts = splitLocation(resp.location);
        fresh.results[fresh.cursor] = {
          location: resp.location || '',
          city: parts.city,
          region: parts.region,
          country: parts.country,
          status: resp.status,
        };
      }

      fresh.cursor += 1;
      await saveState(fresh);

      if (fresh.cursor >= fresh.rows.length) {
        fresh.status = 'done';
        await saveState(fresh);
        break;
      }

      await sleep(jitter(fresh.delayMs));
    }
  } catch (err) {
    const state = await loadState();
    state.status = 'paused';
    state.lastError = 'Loop error: ' + (err && err.message ? err.message : String(err));
    await saveState(state);
  } finally {
    loopActive = false;
  }
}

// ─── Heartbeat: resume after a service-worker restart ─────────────────────────

chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  const state = await loadState();
  if (state.status === 'running' && !loopActive) {
    // The worker was killed mid-run. Pick up from the persisted cursor.
    runLoop();
  }
});

// Keep-alive port from the content script. Just holding it open and receiving
// messages resets the worker's idle timer.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'keepalive') return;
  port.onMessage.addListener(() => { /* the message itself is the point */ });
});

// ─── Popup API ────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  (async () => {
    try {
      switch (msg.type) {
        case 'GET_STATE': {
          const state = await loadState();
          sendResponse({
            ok: true,
            status: state.status,
            total: state.rows.length,
            cursor: state.cursor,
            delayMs: state.delayMs,
            verbose: state.verbose,
            lastError: state.lastError,
            // Last few results, newest first, for the live log.
            recent: state.results
              .slice(Math.max(0, state.cursor - 8), state.cursor)
              .map((r, i) => ({
                index: Math.max(0, state.cursor - 8) + i,
                location: r ? r.location : '',
                status: r ? r.status : '',
              }))
              .reverse(),
          });
          break;
        }

        case 'LOAD_CSV': {
          const state = blankState();
          state.headers = msg.headers;
          state.rows = msg.rows;
          state.urlColIndex = msg.urlColIndex;
          state.delimiter = msg.delimiter || ',';
          state.results = new Array(msg.rows.length).fill(null);
          await saveState(state);
          sendResponse({ ok: true, total: msg.rows.length });
          break;
        }

        case 'START': {
          const state = await loadState();
          if (!state.rows.length) { sendResponse({ ok: false, error: 'No CSV loaded.' }); break; }
          state.status = 'running';
          state.lastError = '';
          state.delayMs = msg.delayMs || state.delayMs;
          state.verbose = !!msg.verbose;
          if (!state.startedAt) state.startedAt = Date.now();
          await saveState(state);
          runLoop();
          sendResponse({ ok: true });
          break;
        }

        case 'PAUSE': {
          const state = await loadState();
          state.status = 'paused';
          await saveState(state);
          sendResponse({ ok: true });
          break;
        }

        case 'RESET': {
          await saveState(blankState());
          sendResponse({ ok: true });
          break;
        }

        case 'EXPORT': {
          const state = await loadState();
          const headers = state.headers.concat([
            'LinkedIn Location', 'City', 'Region', 'Country', 'Enrich Status',
          ]);
          const rows = state.rows.map((row, i) => {
            const r = state.results[i] || { location: '', city: '', region: '', country: '', status: 'pending' };
            return row.concat([r.location, r.city, r.region, r.country, r.status]);
          });
          sendResponse({ ok: true, headers, rows, delimiter: state.delimiter });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown message type: ' + msg.type });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  })();

  return true; // async sendResponse
});
