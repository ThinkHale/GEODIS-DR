'use strict';

const XLSX = require('xlsx');

function text(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }
function num(v) { const n = Number(String(v == null ? '' : v).replace(/[$,]/g, '')); return Number.isFinite(n) ? n : null; }
function hash(s) { let h = 0; for (const c of String(s)) h = ((h << 5) - h + c.charCodeAt(0)) | 0; return Math.abs(h).toString(36); }
function rows(wb, name) { const ws = wb.Sheets[name]; return ws ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null }).slice(1) : []; }
function isoDate(v, year) {
  const s = text(v); if (!s) return '';
  let m = s.match(/(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?/);
  if (!m) { const d = new Date(s + (/[0-9]{4}/.test(s) ? '' : ' ' + (year || new Date().getFullYear()))); if (!isNaN(d)) return d.toISOString().slice(0, 10); return ''; }
  let y = Number(m[3] || year || new Date().getFullYear()); if (y < 100) y += 2000;
  const d = new Date(y, Number(m[1]) - 1, Number(m[2]));
  return isNaN(d) ? '' : [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
function dateRange(v, year) {
  const s = text(v), hits = s.match(/\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?/g) || [];
  const start = isoDate(hits[0] || s, year), end = isoDate(hits[hits.length - 1] || s, year);
  return { start, end: end || start };
}
function match(name, byName, rosterKey) {
  const hit = byName.get(rosterKey(name));
  return hit ? { badge: hit.badge || '', market: hit.market || '' } : { badge: '' };
}
function statusOf(row) {
  const paid = text(row[12]).toLowerCase(), approved = text(row[10]).toLowerCase();
  if (/yes|submit|process|paid/.test(paid)) return 'Submitted to Payroll';
  if (/yes|approved|\d/.test(approved)) return 'Approved';
  return 'Received';
}
function build(buffer, opts) {
  opts = opts || {}; const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const now = opts.now || new Date().toISOString(), year = Number(now.slice(0, 4));
  const byName = opts.byName, rosterKey = opts.rosterKey;
  const grouped = new Map();
  rows(wb, 'Transition Employees PTO Balanc').forEach((r, i) => {
    const name = text(r[1] + ' ' + r[2]); if (!text(r[1]) && !text(r[2])) return;
    const key = rosterKey(name), prior = grouped.get(key), remaining = num(r[7]), opening = num(r[4]);
    const item = prior || { name, account: text(r[0]), initial: opening, balance: remaining, row: i + 2 };
    if (item.initial == null && opening != null) item.initial = opening;
    if (remaining != null) item.balance = remaining;
    item.row = i + 2; grouped.set(key, item);
  });
  const associatePto = Array.from(grouped.values()).map(x => {
    const hit = match(x.name, byName, rosterKey);
    return { id: 'TP-' + hash(rosterKey(x.name)), badge: hit.badge, name: x.name,
      transitionAssociate: 'true', transitionPtoInitial: x.initial == null ? (x.balance || 0) : x.initial,
      transitionPtoBalance: x.balance == null ? 0 : x.balance, source: opts.source,
      sourceAccount: x.account, importedAt: now, notes: hit.badge ? '' : 'Not matched to the current roster' };
  });
  const timeOff = rows(wb, 'PTO Request Off').filter(r => text(r[1]) && !/^example\b/i.test(text(r[1]))).map((r, i) => {
    const name = text(r[1]).replace(/\s*\/\s*\d+\s*$/, ''), hit = match(name, byName, rosterKey);
    const rawDate = text(r[4]), dates = dateRange(rawDate, year), start = dates.start, hours = num(r[5]) || 0;
    const notes = [text(r[6]), text(r[7]), text(r[9]) && 'PTO balance note: ' + text(r[9]),
      text(r[10]) && 'Client approval: ' + text(r[10]), text(r[11]) && 'Attendance sheet: ' + text(r[11]),
      text(r[12]) && 'Payroll: ' + text(r[12]), !start && rawDate && 'Original requested date: ' + rawDate].filter(Boolean).join(' | ');
    return { id: 'PTO-XLS-' + hash([name, rawDate, hours, i].join('|')), badge: hit.badge, name, type: 'PTO',
      start, end: dates.end, hours, status: statusOf(r), notes, shift: text(r[3]), location: text(r[0]),
      source: opts.source, submittedAt: now, legacyBalanceApplied: 'true', importRef: 'PTO Request Off row ' + (i + 2) };
  });
  const discrepancies = rows(wb, 'Payroll Discrepencies').filter(r => text(r[0]) && !/^example\b/i.test(text(r[0]))).map((r, i) => {
    const name = text(r[0]), hit = match(name, byName, rosterKey), action = text(r[8]);
    const details = ['Paid: ' + text(r[3]), 'Claimed: ' + text(r[4]), 'Missing: ' + text(r[5]),
      'Client confirmed: ' + text(r[6]), 'Beeline: ' + text(r[7]), action && 'OCP: ' + action,
      text(r[9]) && 'Billing: ' + text(r[9])].filter(x => !/: $/.test(x)).join(' | ');
    const date = isoDate(action, year);
    return { id: 'PAY-XLS-' + hash([name, details, i].join('|')), badge: hit.badge, name, location: text(r[1]),
      date, weekEnding: '', details, status: /process|submit/i.test(action) ? 'Submitted to Payroll' : 'Researching',
      source: opts.source, submittedAt: now, notes: 'Shift: ' + text(r[2]) };
  });
  return { associatePto, timeOff, discrepancies, sheets: wb.SheetNames };
}

module.exports = { build, isoDate, dateRange };
