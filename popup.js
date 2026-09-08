// ─── CSV parsing ──────────────────────────────────────────────────────────────
// Hand-rolled because extension CSP blocks CDN scripts and a dependency isn't
// worth it here. Handles quoted fields, escaped quotes, and CRLF.

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  // French Excel exports use ';' by default.
  return semis > commas ? ';' : ',';
}

function parseCSV(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\r') {
      // ignore; handled by \n
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  // Drop trailing fully-empty rows.
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows;
}

function toCSV(headers, rows, delimiter) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /["\n\r]|[;,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(esc).join(delimiter)];
  for (const r of rows) lines.push(r.map(esc).join(delimiter));
  return lines.join('\r\n');
}

// Find the column most likely to hold LinkedIn URLs: header name first, then
// fall back to sniffing the data.
function findUrlColumn(headers, rows) {
  const byName = headers.findIndex((h) =>
    /linkedin|profile|url|lien|site/i.test(String(h || ''))
  );
  if (byName !== -1) return byName;

  const sample = rows.slice(0, 30);
  let best = -1, bestHits = 0;
  const colCount = Math.max(headers.length, ...sample.map((r) => r.length), 0);
  for (let c = 0; c < colCount; c++) {
    let hits = 0;
    for (const r of sample) {
      if (r[c] && /linkedin\.com\//i.test(r[c])) hits++;
    }
    if (hits > bestHits) { bestHits = hits; best = c; }
  }
  return bestHits > 0 ? best : -1;
}

// ─── UI wiring ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

let hasData = false;

$('file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const text = await file.text();
  const delimiter = detectDelimiter(text);
  const all = parseCSV(text, delimiter);

  if (all.length < 2) {
    $('fileInfo').textContent = 'That file has no data rows.';
    return;
  }

  const headers = all[0];
  const rows = all.slice(1);
  const urlColIndex = findUrlColumn(headers, rows);

  if (urlColIndex === -1) {
    $('fileInfo').innerHTML =
      '<span style="color:#b00020">No LinkedIn URL column found. ' +
      'Name a column "LinkedIn URL" or make sure the cells contain linkedin.com links.</span>';
    return;
  }

  const resp = await send({ type: 'LOAD_CSV', headers, rows, urlColIndex, delimiter });
  if (!resp || !resp.ok) {
    $('fileInfo').innerHTML = '<span style="color:#b00020">Load failed: ' + (resp && resp.error) + '</span>';
    return;
  }

  hasData = true;
  $('fileInfo').textContent =
    rows.length + ' rows · URL column: "' + (headers[urlColIndex] || ('#' + (urlColIndex + 1))) + '"' +
    ' · delimiter "' + delimiter + '"';
  refresh();
});

$('start').addEventListener('click', async () => {
  const delayMs = Math.max(3, parseInt($('delay').value, 10) || 10) * 1000;
  await send({ type: 'START', delayMs, verbose: $('verbose').checked });
  refresh();
});

$('pause').addEventListener('click', async () => {
  await send({ type: 'PAUSE' });
  refresh();
});

$('reset').addEventListener('click', async () => {
  if (!confirm('Clear the loaded CSV and all results?')) return;
  await send({ type: 'RESET' });
  hasData = false;
  $('file').value = '';
  $('fileInfo').textContent = 'No file loaded.';
  refresh();
});

$('export').addEventListener('click', async () => {
  const resp = await send({ type: 'EXPORT' });
  if (!resp || !resp.ok) return;
  const csv = toCSV(resp.headers, resp.rows, resp.delimiter);
  // BOM so Excel opens accented characters correctly (Nîmes, Île-de-France…).
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'linkedin-locations-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

// ─── Progress polling ─────────────────────────────────────────────────────────

async function refresh() {
  const s = await send({ type: 'GET_STATE' });
  if (!s || !s.ok) return;

  const running = s.status === 'running';
  const total = s.total || 0;
  hasData = hasData || total > 0;

  $('start').disabled = !hasData || running;
  $('start').textContent = s.cursor > 0 && s.status !== 'done' ? 'Resume' : 'Start';
  $('pause').disabled = !running;
  $('export').disabled = total === 0;

  const pct = total ? Math.round((s.cursor / total) * 100) : 0;
  $('barFill').style.width = pct + '%';

  const labels = { idle: 'Idle.', running: 'Running…', paused: 'Paused.', done: 'Finished.' };
  $('progress').textContent = total
    ? `${labels[s.status] || s.status} ${s.cursor}/${total} (${pct}%)`
    : (labels[s.status] || s.status);

  $('error').textContent = s.lastError || '';

  const log = $('log');
  if (!s.recent || s.recent.length === 0) {
    log.innerHTML = '<div class="muted">Nothing yet.</div>';
  } else {
    log.innerHTML = s.recent.map((r) => {
      const cls = r.status === 'ok' ? 'ok' : (r.status === 'not_found' ? 'nf' : 'bad');
      const text = r.location || r.status;
      return `<div class="${cls}">#${r.index + 1} — ${escapeHtml(text)}</div>`;
    }).join('');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

refresh();
setInterval(refresh, 1500);
