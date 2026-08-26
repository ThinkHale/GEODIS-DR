'use strict';

const XLSX = require('xlsx');

function text(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }
function num(v) { const n = Number(text(v)); return Number.isFinite(n) ? n : null; }
function hash(s) { let h = 0; for (const c of String(s)) h = ((h << 5) - h + c.charCodeAt(0)) | 0; return Math.abs(h).toString(36); }
function iso(v, year) {
  const s = text(v); if (!s || s === '0') return '';
  const m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/); if (!m) return '';
  let y = Number(m[3]); if (y < 100) y += 2000; if (!m[3]) y = year;
  const d = new Date(y, Number(m[1]) - 1, Number(m[2]));
  return isNaN(d) ? '' : [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
function cleanName(v) {
  return text(v).replace(/\s+-\s*\d+\s*(?:am|pm)?\s*$/i, '').replace(/\s+\d+\s*(?:am|pm)\s*$/i, '').trim();
}
function match(name, byName, rosterKey) {
  const key = rosterKey(cleanName(name)); return key && byName.has(key) && byName.get(key) ? byName.get(key) : null;
}
function kind(comment) {
  const s = text(comment).toLowerCase();
  if (/ncns|no call/.test(s)) return { type: 'No Call / No Show', points: 4 };
  if (/late/.test(s)) return { type: 'Late', points: 1 };
  if (/left early|leave early|clocked out early/.test(s)) return { type: 'Early Out', points: 1 };
  if (/called off|call off|absent|not onsite/.test(s)) return { type: 'Absent', points: 2 };
  if (/approved|plaw|pto|psl|time off|doctor|rescheduled/.test(s)) return { type: 'Excused', points: 0 };
  return { type: 'Excused', points: 0 };
}
function event(name, date, comment, points, meta, opts) {
  const hit = match(name, opts.byName, opts.rosterKey), k = kind(comment);
  const p = points == null ? k.points : points;
  return { id: 'AT-XLS-' + hash([opts.rosterKey(name), date, k.type, meta.source].join('|')), badge: hit ? hit.badge : '',
    name: cleanName(name), date, type: k.type, minutes: 0, points: p, notes: text(comment),
    source: meta.source, importRef: meta.ref, location: meta.location || '', shift: meta.shift || '' };
}
function parsePlx(buffer, opts) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true }), events = [], balances = [], transitions = [];
  const ws = wb.Sheets['2026 Attendance'];
  if (ws) {
    const a = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
    [[0, '2026 Attendance'], [14, '2026 Attendance transition history']].forEach(([base, label]) => {
      a.slice(2).forEach((r, i) => {
        const name = cleanName(r[base + 2]), date = iso(r[base + 6]); if (!name || !date) return;
        const rawPoints = num(r[base + 7]), comment = text(r[base + 8]);
        if (rawPoints == null && !comment) return;
        events.push(event(name, date, comment, rawPoints, { source: opts.plxSource, ref: label + ' row ' + (i + 3), location: text(r[base + 1]), shift: text(r[base + 5]) }, opts));
      });
    });
  }
  const at = wb.Sheets['Attendance Tracker'];
  if (at) XLSX.utils.sheet_to_json(at, { header: 1, defval: null, raw: false }).slice(1).forEach((r, i) => {
    const name = cleanName(r[2]), date = iso(r[1]), approval = text(r[5]), comment = [text(r[6]), approval].filter(Boolean).join(' - ');
    if (!name || !date || !comment) return;
    const pts = /approved/i.test(approval) ? 0 : null;
    events.push(event(name, date, comment, pts, { source: opts.plxSource, ref: 'Attendance Tracker row ' + (i + 2), location: text(r[0]), shift: text(r[3]) }, opts));
  });

  wb.SheetNames.filter(n => /\bHC\b/i.test(n)).forEach(sheetName => {
    const a = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, raw: false }); if (a.length < 2) return;
    const headers = a[1].map(text);
    headers.forEach((h, nameCol) => {
      if (!/Employee\s+Name/i.test(h)) return;
      const pointsCol = headers.findIndex((x, j) => j > nameCol && j <= nameCol + 5 && /Current Points/i.test(x));
      const flagCol = nameCol > 0 && /Transition|Status/i.test(headers[nameCol - 2] || '') ? nameCol - 2 : -1;
      a.slice(2).forEach((r, i) => {
        const name = cleanName(r[nameCol]); if (!name) return; const hit = match(name, opts.byName, opts.rosterKey);
        const points = pointsCol >= 0 ? num(r[pointsCol]) : null;
        if (points != null) balances.push({ name, badge: hit ? hit.badge : '', points, sheet: sheetName, row: i + 3 });
        const flag = flagCol >= 0 ? text(r[flagCol]) : '';
        if (/^(y|yes|transition)$/i.test(flag)) transitions.push({ name, badge: hit ? hit.badge : '', source: sheetName + ' row ' + (i + 3) });
      });
    });
  });
  return { events, balances, transitions };
}
function parseRedbull(buffer, opts) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true }), events = [];
  wb.SheetNames.forEach(sheetName => {
    if (/punch|sheet1/i.test(sheetName)) return;
    const a = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, raw: false }); if (!a.length) return;
    const dates = a[0].map(v => iso(v));
    a.slice(1).forEach((r, i) => {
      const name = cleanName(r[0]); if (!name || /^new starts/i.test(name)) return;
      for (let c = 2; c < r.length; c++) {
        const date = dates[c], status = text(r[c]), low = status.toLowerCase(); if (!date || !status) continue;
        if (/^on[ -]?time$|terminated|quit|^tem$|^pending$|^\*$|no work|sunflower/i.test(low)) continue;
        if (!/late|called[ -]?off|ncns|doctor|rescheduled/i.test(low)) continue;
        events.push(event(name, date, status, null, { source: opts.redbullSource, ref: sheetName + ' row ' + (i + 2), location: '1536' }, opts));
      }
    });
  });
  return events;
}
function build(plxBuffer, redbullBuffer, opts) {
  const plx = parsePlx(plxBuffer, opts), redbull = parseRedbull(redbullBuffer, opts), byKey = new Map();
  plx.events.concat(redbull).forEach(e => { const key = [opts.rosterKey(e.name), e.date, e.type].join('|'); if (!byKey.has(key) || !byKey.get(key).badge) byKey.set(key, e); });
  const events = Array.from(byKey.values()), sums = new Map();
  events.forEach(e => { if (e.badge) sums.set(e.badge, (sums.get(e.badge) || 0) + Number(e.points || 0)); });
  plx.balances.forEach(b => {
    if (!b.badge) return; const current = Math.round((sums.get(b.badge) || 0) * 100) / 100, delta = Math.round((b.points - current) * 100) / 100;
    if (!delta) return;
    events.push({ id: 'AT-BAL-' + hash(b.badge), badge: b.badge, name: b.name, date: opts.asOf,
      type: 'Balance Adjustment', minutes: 0, points: delta, notes: 'Reconciled to Current Points ' + b.points + ' from ' + b.sheet,
      source: opts.plxSource, importRef: b.sheet + ' row ' + b.row, location: '', shift: '' });
    sums.set(b.badge, b.points);
  });
  return { events, balances: plx.balances, transitions: plx.transitions,
    summary: { detailed: byKey.size, adjustments: events.length - byKey.size, total: events.length,
      matched: events.filter(e => e.badge).length, unmatched: events.filter(e => !e.badge).length,
      transitionFlags: plx.transitions.length, matchedTransitions: plx.transitions.filter(x => x.badge).length } };
}

module.exports = { build, parsePlx, parseRedbull, kind, cleanName, iso };
