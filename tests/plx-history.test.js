/* Seven days of PLX workbook uploads, and what changed between them: the
   snapshot and diff (plx-history-core.js), the history the sync keeps, and the
   Meeting Prep endpoint. */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const H = require('../plx-history-core.js');
const SK = require('../shift-key.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

t('the deployed copy is identical',
  fs.readFileSync(path.join(__dirname, '..', 'plx-history-core.js'), 'utf8') ===
  fs.readFileSync(path.join(__dirname, '..', 'functions', 'plx-history-core.js'), 'utf8'));

/* A miniature workbook, as the [{ name, aoa }] list the sync builds. `opts`
   varies what a later upload would show. */
function sheets(o) {
  o = o || {};
  const hc = [
    ['PLX - 1ST SHIFT HEADCOUNT'],
    ['Transition', 'Dept', 'Employee  Name', 'EID', 'Start Date', 'Shift ', 'Current Points', 'Comments', '', 'Dept', 'Employee  Name', 'EID', 'Start Date', 'Shift ', 'Current Points', 'Comments'],
    ['', '1502-18109', 'Grachen, Luz', '80-LGRACH3897', '5/28/26', '1st', '2', '', '', '1502-18845', 'Munoz, Abel', '80-AMUNOZ8734', '6/9/26', '2nd', '0', '']
  ];
  if (o.ended !== true) hc.push(['', '1502-18340', 'Valadez, Ma G', '80-MVALAD8711', '6/4/26', '1st', '0', '']);
  // A new start with no shift yet still started an assignment.
  if (o.newStart) hc.push(['', '1502-18340', 'Nuevo, Ana', '80-ANUEVO1111', '9/30/26', '', '0', '']);
  const cand = (title, rows) => [[title], ['Building ', 'Agency', 'Account', '(Last Name, First Name)', 'Position', 'Shift', 'Start Date', 'WT Date & Time', 'Job Function ']].concat(rows);
  const wt = [['1502', 'PLX', 'CCM', '', 'Operator', '1st', '', '', 'Reach']];
  if (!o.slotFilled) wt.push(['1502', 'PLX', 'CCM', '', 'Operator', '1st', '', '', 'Reach']);
  if (o.slotFilled) wt.push(['1502', 'PLX', 'CCM', 'Slot, Filler', 'Operator', '1st', '', o.wtSlot || '', 'Reach']);
  const pipe = [];
  if (!o.zStarted) pipe.push(['1502', 'PLX', 'Redbull', ' Zambrano, Leidy', 'Operator', '1st', 'Pending', '07/30 @10am', 'Reach']);
  pipe.push(['1536', 'PLX', 'Redbull', 'Benitez, Wilian', 'Operator', '1st', 'Pending', o.benitezWt || '', 'Reach']);
  if (!o.cancelOrtiz) pipe.push(['1536', 'PLX', 'Redbull', 'Ortiz, Mia', 'Operator', '2nd', 'Pending', '8/1 9am', 'Reach']);
  if (o.rescheduleRay) pipe.push(['1536', 'PLX', 'Redbull', 'Ray, Sam', 'Operator', '2nd', 'Pending', '8/9 9am', 'Reach']);
  else pipe.push(['1536', 'PLX', 'Redbull', 'Ray, Sam', 'Operator', '2nd', 'Pending', '8/2 9am', 'Reach']);
  const started = [['1559', 'PLX', 'POST', 'Zupancic, Alex', 'Operator', 'B', '1/19/26', '1/16 2pm', 'SDFL']];
  if (o.zStarted) started.push(['1502', 'PLX', 'Redbull', 'Zambrano, Leidy', 'Operator', '1st', '9/1/26', '07/30 @10am', 'Reach']);
  const dnr = [['1559', 'ProLogistix', 'POST', 'Holley, Christian', 'Operator', '', '', '', '']];
  if (o.cancelOrtiz) dnr.push(['1536', 'PLX', 'Redbull', 'Ortiz, Mia', 'Operator', '2nd', '', '8/1 9am', 'Reach']);
  const reqs = [
    ['REQS BY BUILDINGS'],
    ['Agency', 'Building ', 'Account Name ', 'Account ', 'Hire Date', 'Shift ', 'Job Type ', 'Req #', 'Quantity ', 'Report To', 'Job Function ', 'Notes'],
    ['PLX', '1502', 'CCM', '18845', '8/31/26', '2nd', 'OPR 2', '110426', o.qty || '6', 'M', 'Picker', '']
  ];
  if (!o.filled) reqs.push(['PLX', '1500', 'Lindt ', '18086', '8/24/26', '1st ', 'OPR 1 ', '110150', '2', 'B', 'Reach/EPJ ', '']);
  if (o.newOrder) reqs.push(['PLX', '1536', 'Redbull', '67510', '10/5/26', '1st', 'OPR 1', '111000', '4', 'C', 'Reach', '']);
  const att = [
    ['', '', '', '', '', '', '', 'note'],
    ['Agency', 'Building', 'Employee  Name', 'EID', 'Start Date', 'Shift ', 'Date of Absence', 'Points Earning', 'Comments'],
    ['PLX', '1502-18109', 'Grachen, Luz', '80-LGRACH3897', '5/28/26', '1st', '9/1/26', '1', 'Late']
  ];
  if (o.occurrence) att.push(['PLX', '1502-18109', 'Grachen, Luz', '80-LGRACH3897', '5/28/26', '1st', '9/29/26', '2', 'Called off']);
  return [
    { name: '2026 - Beeline Reqs', aoa: reqs },
    { name: 'Chicago WT List', aoa: cand('CHICAGO CAMPUS - LIST OF OPENINGS', wt) },
    { name: 'Pipeline', aoa: cand('STANDBY CANDIDATES', pipe) },
    { name: '1502 - HC', aoa: hc },
    { name: '2026 Attendance', aoa: att },
    { name: '2026 - STARTED', aoa: cand('2026 - STARTED', started) },
    { name: '2026 - NOT ELIGIBLE Cancelled', aoa: cand('2026 - DNR OR CANCELLED', dnr) }
  ];
}
const snap = o => H.snapshot(sheets(o), { ShiftKey: SK, takenAt: '2026-09-30T08:00:00Z' });

console.log('— the snapshot —');
let a = snap();
t('both HC blocks are read', Object.keys(a.roster).length === 3);
t('keyed by EID', !!a.roster['80-AMUNOZ8734']);
t('with its building', a.roster['80-AMUNOZ8734'].location === '1502');
t('candidates from every stage tab', Object.keys(a.candidates).length === 6);
t('a pipeline candidate', a.candidates[H.nameKey('Zambrano, Leidy')].stage === 'pipeline');
t('names are trimmed', a.candidates[H.nameKey('Zambrano, Leidy')].name === 'Zambrano, Leidy');
t('the misspelt "Biuilding" header is not needed by other tabs', a.candidates[H.nameKey('Holley, Christian')].stage === 'cancelled');
t('a nameless WT List row is an open slot', a.openSlots['1502'] === 2);
t('orders by Req #', Object.keys(a.orders).length === 2 && a.orders['110150'].openings === 2);
t('attendance occurrences', Object.keys(a.attendance).length === 1);
t('stage words', H.stageOf('2026 - NOT ELIGIBLE Cancelled') === 'cancelled' && H.stageOf('2025 - DNR & CANCELLED') === 'cancelled' &&
  H.stageOf('2026 - STARTED') === 'started' && H.stageOf('Chicago WT List') === 'openings' && H.stageOf('1502 - HC') === '');

console.log('— one name on two tabs: the furthest stage wins —');
const dup = sheets();
dup[5].aoa.push(['1502', 'PLX', 'Redbull', 'Leidy Zambrano', 'Operator', '1st', '9/1/26', '', 'Reach']);
t('started beats pipeline whichever tab is read first',
  H.snapshot(dup, { ShiftKey: SK }).candidates[H.nameKey('Zambrano, Leidy')].stage === 'started');

console.log('— nothing changed —');
let d = H.diff(a, snap());
t('no change is no change', !H.changed(d.counts));
t('headcount still reported', d.counts.headcountFrom === 3 && d.counts.headcountTo === 3);

console.log('— everything changed —');
const b = snap({ ended: true, newStart: true, zStarted: true, cancelOrtiz: true, rescheduleRay: true,
  benitezWt: '10/2 10am', filled: true, newOrder: true, qty: '8', occurrence: true, slotFilled: true });
d = H.diff(a, b);
t('a new EID started', d.counts.started === 1 && d.assignments.started[0].eid === '80-ANUEVO1111');
t('even without a shift', d.assignments.started[0].shift === '');
t('a vanished EID ended', d.counts.ended === 1 && d.assignments.ended[0].name === 'Valadez, Ma G');
t('headcount nets out', d.counts.headcountFrom === 3 && d.counts.headcountTo === 3);
t('a WT date entered is scheduled', d.walkthroughs.scheduled.some(x => x.name === 'Benitez, Wilian' && x.wtDate === '10/2 10am'));
t('a filled slot with no WT date yet is not scheduled', !d.walkthroughs.scheduled.some(x => x.name === 'Slot, Filler'));
t('scheduled count', d.counts.wtScheduled === 1);
t('a changed WT date is rescheduled, not scheduled',
  d.counts.wtRescheduled === 1 && d.walkthroughs.rescheduled[0].fromWtDate === '8/2 9am');
t('moving to STARTED completes the walkthrough',
  d.counts.wtCompleted === 1 && d.walkthroughs.completed[0].fromStage === 'pipeline');
t('moving to the DNR tab cancels it', d.counts.wtCancelled === 1 && d.walkthroughs.cancelled[0].name === 'Ortiz, Mia');
t('a new Req # is a created order', d.counts.ordersCreated === 1 && d.counts.openingsCreated === 4);
t('a Req # that left is filled/closed', d.counts.ordersClosed === 1 && d.orders.closed[0].req === '110150');
t('a new quantity is a change', d.counts.ordersChanged === 1 && d.orders.changed[0].fromOpenings === 6);
t('a new occurrence is logged', d.counts.occurrences === 1 && d.attendance.logged[0].date === '9/29/26');
t('open slots fall when one is filled', d.counts.openSlotsFrom === 2 && d.counts.openSlotsTo === 1);
t('it reads as changed', H.changed(d.counts));

console.log('— a slot filled with a WT date is scheduled —');
d = H.diff(a, snap({ slotFilled: true, wtSlot: '10/3 1pm' }));
t('scheduled', d.walkthroughs.scheduled.some(x => x.name === 'Slot, Filler'));

console.log('— narrowing to some buildings —');
d = H.diff(a, b);
const only1536 = H.filterDiff(d, x => x.location === '1536');
t('other buildings drop out', only1536.counts.started === 0 && only1536.counts.ended === 0);
t('this building stays', only1536.counts.ordersCreated === 1 && only1536.counts.wtCancelled === 1);
t('headcount follows', only1536.headcount.every(x => x.location === '1536'));
t('the original is untouched', d.counts.started === 1);

console.log('— retention —');
const e = (id, takenAt) => ({ id, takenAt });
let p = H.prune([e('a', '2026-09-20T08:00:00Z'), e('b', '2026-09-25T08:00:00Z'), e('c', '2026-09-30T08:00:00Z')], '2026-10-01T08:00:00Z');
t('older than 7 days is dropped', p.drop.map(x => x.id).join() === 'a');
t('the rest is kept, oldest first', p.keep.map(x => x.id).join() === 'b,c');
p = H.prune([e('old', '2026-09-01T08:00:00Z'), e('older', '2026-08-01T08:00:00Z')], '2026-10-01T08:00:00Z');
t('the newest is kept however old -- it is the next baseline', p.keep.map(x => x.id).join() === 'old');
t('exactly 7 days is kept', H.prune([e('x', '2026-09-24T08:00:00Z'), e('y', '2026-10-01T08:00:00Z')], '2026-10-01T08:00:00Z').keep.length === 2);

console.log('— which upload a window starts from —');
const list = [e('a', '2026-09-25T08:00:00Z'), e('b', '2026-09-30T08:00:00Z'), e('c', '2026-09-30T16:00:00Z')];
let bl = H.baselineFor(list, '2026-09-30T12:00:00Z');
t('the newest at or before the start', bl.entry.id === 'b' && !bl.partial);
bl = H.baselineFor(list, '2026-09-01T00:00:00Z');
t('past the history: the oldest, marked partial', bl.entry.id === 'a' && bl.partial);
t('no history, no baseline', H.baselineFor([], '2026-09-01T00:00:00Z') === null);
t('ids sort by time', H.idFor('2026-09-30T08:00:00.123Z', 'abcdef0123') === '20260930080000-abcdef01');

console.log('— colours, positions and dates —');
t('Excel light green is green', H.colorName('D9F2D0') === 'green' && H.colorName('92D050') === 'green' && H.colorName('B4E5A2') === 'green');
t('light and bright blue are blue', H.colorName('DDEBF7') === 'blue' && H.colorName('00B0F0') === 'blue' && H.colorName('9BC2E6') === 'blue');
t('red, yellow, orange keep their names', H.colorName('FF0000') === 'red' && H.colorName('FFFF00') === 'yellow' && H.colorName('FFC000') === 'orange');
t('white and grey are no highlight', H.colorName('FFFFFF') === '' && H.colorName('D9D9D9') === '' && H.colorName('') === '');
t('MATH codes and titles are material handlers', ['MATH3', 'MATH 2', 'Material Handler', 'Sr Material Handler', 'PAB Picker']
  .every(x => H.positionOf(x) === 'Material Handler'));
t('OPR codes and titles are operators', ['OPR 1', 'OPEPJ', 'Operator', 'Opeator 1', 'Electric Pallet Jack', 'Reach']
  .every(x => H.positionOf(x) === 'Operator'));
t('anything else keeps its title', H.positionOf('CSR') === 'CSR' && H.positionOf('', '') === 'Unspecified');
t('the first field that names a group wins', H.positionOf('', 'Sit Down') === 'Operator');
t('m/d/yy', H.parseDay('8/24/26').toISOString().slice(0, 10) === '2026-08-24');
t('with a time after it', H.parseDay('08/24/2026 @7am').toISOString().slice(0, 10) === '2026-08-24');
t('day-month takes the tab year', H.parseDay('22-Sep', 2025).toISOString().slice(0, 10) === '2025-09-22');
t('Pending is no date', H.parseDay('Pending', 2026) === null && H.parseDay('2/30/26') === null);
t('weeks start on Monday', H.weekOf('2026-10-01') === '2026-09-28' && H.weekOf('2026-09-28') === '2026-09-28' &&
  H.weekOf('2026-10-04') === '2026-09-28');

console.log('— customers, sites and starts —');
function keyed(o) {
  const list = sheets(o);
  list.unshift({ name: 'Geodis Key', aoa: [
    ['', '', '', '', '', '', '', 'Building', 'Job Title', 'Account Name', 'Account Num', 'Beeline Shift', 'Shift', 'Schedule'],
    ['', '', '', '', '', '', '', '1502', 'OPR2', 'CCM', '18845', '1', '1st', '6am-2:30pm Mon-Fri'],
    ['', '', '', '', '', '', '', '1502', 'OPR2', 'LEGO SAH', '18109', '1', '1st', '6am-2:30pm Mon-Fri'],
    ['', '', '', '', '', '', '', '1502', 'MATH1', 'CLEAN CULT', '18340', '1', '1st', '6am-2:30pm Mon-Fri'],
    ['', '', '', '', '', '', '', '1536', 'OPR1', 'REDBULL', '67510', '1', '1st', '6am-2:30pm Mon-Fri']] });
  const hc = list.find(x => x.name === '1502 - HC');
  hc.aoa[0] = ['PLX - 1ST SHIFT HEADCOUNT', '', '', '', '', '', '', '', 'Expected', 'Onsite', 'Short'];
  hc.aoa[1] = hc.aoa[1].slice(0, 8).concat(['4', '3', '1']).concat(hc.aoa[1].slice(8));
  // Shift the right-hand block over by the three figures just added.
  hc.aoa.slice(2).forEach((r, i) => { hc.aoa[i + 2] = r.slice(0, 8).concat(['', '', '']).concat(r.slice(8)); });
  return list;
}
let k = H.snapshot(keyed(), { ShiftKey: SK });
t('customers per site from the Key', k.customers['1502'].join() === 'CCM,LEGO SAH,CLEAN CULT');
t('an associate gets the customer of their Dept account', k.roster['80-LGRACH3897'].customer === 'LEGO SAH' &&
  k.roster['80-AMUNOZ8734'].customer === 'CCM');
t('expected, onsite and short from the HC header', k.sites['1502'].expected === 4 && k.sites['1502'].onsite === 3 && k.sites['1502'].short === 1);
t('an order gets its customer by account number', k.orders['110426'].customer === 'CCM');
t('and its position, from the job type first', k.orders['110426'].position === 'Operator' && k.orders['110150'].position === 'Operator');
t('a candidate gets the Key spelling of the customer', k.candidates[H.nameKey('Benitez, Wilian')].customer === 'REDBULL');
t('a one-customer site fills a blank account', H.snapshot(keyed(), { ShiftKey: SK }).candidates[H.nameKey('Ray, Sam')].customer === 'REDBULL');
t('starts per week from the STARTED tab', k.starts.length === 1 && k.starts[0].week === '2026-01-19' && k.starts[0].count === 1);

console.log('— highlights —');
function coloured(o, colours) {
  const list = keyed(o);
  const pipe = list.find(x => x.name === 'Pipeline');
  pipe.fills = pipe.aoa.map(r => colours[String(r[3]).trim()] || '');
  list.find(x => x.name === 'Chicago WT List').fills = [];
  return list;
}
const c0 = H.snapshot(coloured({}, {}), { ShiftKey: SK });
const c1 = H.snapshot(coloured({}, { 'Ray, Sam': '92D050', 'Ortiz, Mia': '9BC2E6', 'Benitez, Wilian': 'FF0000' }), { ShiftKey: SK });
t('green is accepted for WT', c1.candidates[H.nameKey('Ray, Sam')].highlight === 'accepted');
t('blue is approved for start', c1.candidates[H.nameKey('Ortiz, Mia')].highlight === 'approved');
t('red is kept by name, with no meaning', c1.candidates[H.nameKey('Benitez, Wilian')].color === 'red' &&
  c1.candidates[H.nameKey('Benitez, Wilian')].highlight === '');
d = H.diff(c0, c1);
t('newly green is reported', d.counts.wtAccepted === 1 && d.walkthroughs.accepted[0].name === 'Ray, Sam');
t('newly blue is reported', d.counts.wtApproved === 1 && d.walkthroughs.approved[0].name === 'Ortiz, Mia');
t('still green is not new', H.diff(c1, c1).counts.wtAccepted === 0);
t('against a snapshot not read for colour, nothing is "new"', H.diff(k, c1).counts.wtAccepted === 0 && !H.diff(k, c1).highlights);
let pr = H.profile(c1);
const rb = pr.rows.find(r => r.location === '1536' && r.customer === 'REDBULL');
t('the profile counts identified candidates by customer', rb.candidates === 3 && rb.accepted === 1 && rb.approved === 1);
t('and keeps the other colours by name', rb.otherColors.red === 1);

console.log('— who is behind the net change —');
d = H.diff(snap(), snap({ ended: true, newStart: true }));
const h1502 = d.headcount.find(x => x.location === '1502');
t('one added, one removed, no net change', h1502.added === 1 && h1502.removed === 1 && h1502.from === h1502.to);

console.log('— the profile —');
pr = H.profile(k);
const ccm = pr.rows.find(r => r.location === '1502' && r.customer === 'CCM');
t('one row per customer at a site', !!ccm && pr.rows.some(r => r.customer === 'CLEAN CULT'));
t('a Dept account names the customer', pr.rows.find(r => r.customer === 'CLEAN CULT').onRoster === 1);
t('a customer with nobody on it still shows', pr.rows.find(r => r.location === '1536' && r.customer === 'REDBULL').onRoster === 0);
t('roster, orders and openings by position', ccm.onRoster === 1 && ccm.orders === 1 && ccm.openingsByPosition.Operator === 6);
t('the site carries its figures and its roster', pr.sites.find(x => x.location === '1502').expected === 4 &&
  pr.sites.find(x => x.location === '1502').onRoster === 3);
const only1536p = H.filterProfile(pr, x => x.location === '1536');
t('narrowed by site', only1536p.rows.every(r => r.location === '1536') && only1536p.sites.every(x => x.location === '1536'));

console.log('— week over week —');
const pt = (at, sites) => ({ takenAt: at, sites });
const pts = [
  pt('2026-09-14T08:00:00Z', { 1502: { onRoster: 10, added: 0, removed: 0 } }),
  pt('2026-09-16T08:00:00Z', { 1502: { onRoster: 12, added: 3, removed: 1 } }),
  // nothing the week of the 21st
  pt('2026-09-29T08:00:00Z', { 1502: { onRoster: 9, added: 2, removed: 5 }, 1536: { onRoster: 4, added: 4, removed: 0 } })
];
let wk = H.weekly(pts, { now: '2026-10-01T00:00:00Z' });
t('one row per week to now', wk.map(w => w.week).join() === '2026-09-14,2026-09-21,2026-09-28');
t('the week ends on its last reading', wk[0].onRoster === 12 && wk[0].added === 3 && wk[0].removed === 1);
t('a quiet week carries forward, with nothing added', wk[1].onRoster === 12 && wk[1].added === 0 && wk[1].readings === 0);
t('and no change', wk[1].change === 0);
t('5 out and 2 in at 1502 is -3 there', wk[2].sites['1502'].change === -3 && wk[2].sites['1502'].added === 2 &&
  wk[2].sites['1502'].removed === 5);
t('a new site counts toward the total', wk[2].onRoster === 13 && wk[2].change === 1);
t('the first week has no change to report', wk[0].change === null);
t('limited to the last N weeks', H.weekly(pts, { now: '2026-10-01T00:00:00Z', weeks: 2 }).length === 2);
t('narrowed by site', H.weekly(H.filterSeries(pts, x => x.location === '1536'), { now: '2026-10-01T00:00:00Z' })[2].onRoster === 4);
t('the series keeps two years', H.pruneSeries([pt('2024-01-01T00:00:00Z', {}), pt('2026-01-01T00:00:00Z', {})], '2026-10-01T00:00:00Z').length === 1);
t('a reading is the snapshot plus who moved', (() => {
  const x = H.seriesPoint(k, H.diff(snap(), snap({ ended: true, newStart: true })));
  return x.sites['1502'].onRoster === 3 && x.sites['1502'].expected === 4 && x.sites['1502'].added === 1;
})());

console.log('— against the real workbook, when present —');
const book = path.join(__dirname, '..', 'PLX - Geodis Spreadsheet.xlsx');
if (!fs.existsSync(book)) {
  console.log('  skipped - workbook not in the repo');
} else {
  const wb = XLSX.readFile(book);
  const real = wb.SheetNames.map(n => ({ name: n, aoa: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }) }));
  const s = H.snapshot(real, { ShiftKey: SK });
  t('associates on the HC tabs', Object.keys(s.roster).length > 250);
  t('the 20 open orders the sync reads', Object.keys(s.orders).length === 20);
  t('candidates on every stage', ['openings', 'pipeline', 'started', 'cancelled'].every(st =>
    Object.keys(s.candidates).some(k => s.candidates[k].stage === st)));
  t('the same file twice is no change', !H.changed(H.diff(s, H.snapshot(real, { ShiftKey: SK })).counts));
  t('small enough to keep a week of', JSON.stringify(s).length < 2 * 1024 * 1024);
}

/* ---------- the endpoint ---------- */
const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
const { makeAuth, reqGet } = require('./fn-auth.js');
const auth = makeAuth();
const consts = src.slice(src.indexOf('const COLLECTIONS = {'), src.indexOf('const NOTES_ORIGIN'));
const helpers = src.slice(src.indexOf('async function readJsonArray'), src.indexOf('async function handleCollection'));
const handler = src.slice(src.indexOf('async function applyPlxWorkbook('), src.indexOf('/* ---------- who is calling ----------'));

let files = {};
const deleted = [];
const bucket = { file: k => ({
  save: async b => { files[k] = b; },
  download: async () => { if (!(k in files)) { const err = new Error('nope'); err.code = 404; throw err; } return [Buffer.from(files[k])]; },
  delete: async () => { deleted.push(k); delete files[k]; }
}) };
async function readJsonFile(k) { try { return JSON.parse(files[k]); } catch (err) { return {}; } }
const MarketAccess = require('../market-access-core.js');
const LOCATIONS = [{ code: '1502', market: 'Chicago' }, { code: '1536', market: 'Joliet' }];

const built = new Function(
  'bucket', 'readJsonFile', 'setKvCors', 'SYNC_KEY', 'NOTES_ORIGIN', 'XLSX', 'ShiftKey', 'Sched', 'Intake',
  'AttendanceImport', 'Contacts', 'rosterProfiles', 'fetch', 'console', 'requireUser',
  'PlxHistory', 'crypto', 'MarketAccess', 'Auth', 'SNAPSHOT_PATH',
  consts + helpers + handler + '\nreturn {handlePlx, handlePlxChanges, PLX_HISTORY_INDEX, COLLECTIONS};'
)(bucket, readJsonFile, () => {}, { value: () => 'k' }, 'https://geodis.ebtools.pro', XLSX, SK,
  require('../schedule-core.js'), require('../form-intake.js'), require('../functions/attendance-import.js'),
  require('../contacts-core.js'), async () => [], async () => ({ ok: true }), console, auth.requireUser,
  H, require('crypto'), MarketAccess, auth.Auth, 'snapshots/latest.json');
const { handlePlx, handlePlxChanges, PLX_HISTORY_INDEX, COLLECTIONS } = built;
// The real market lookup reads Settings > Locations from the bucket.
files[COLLECTIONS.locations.path] = JSON.stringify(LOCATIONS);

const mkRes = () => { const r = { code: null, body: null, set() { return r; }, status(c) { r.code = c; return r; }, json(x) { r.body = x; return r; }, send() { return r; } }; return r; };
const call = async (h, req) => { const res = mkRes(); await h(req, res); return res; };
const toBook = o => {
  const wb = XLSX.utils.book_new();
  sheets(o).forEach(sh => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sh.aoa), sh.name));
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
};
const push = (o, name) => call(handlePlx, { method: 'POST', query: {}, body: { fileBase64: toBook(o), fileName: name || 'PLX.xlsx' },
  get: h => (h === 'x-sync-key' ? 'k' : '') });
const changes = q => call(handlePlxChanges, { method: 'GET', query: Object.assign({ plxChanges: '1' }, q || {}),
  get: reqGet(auth.headers) });
const index = () => JSON.parse(files[PLX_HISTORY_INDEX]).entries;

(async () => {
  console.log('— the first upload —');
  let r = await push();
  t('accepted', r.code === 200);
  t('nothing to compare with is null, not "no change"', r.body.sync.changes === null);
  t('kept in the history', index().length === 1);
  const first = index()[0];
  t('the workbook file is stored', !!files['plx/history/' + first.id + '.xlsx']);
  t('and its snapshot', JSON.parse(files['plx/history/' + first.id + '.json']).version === H.VERSION);
  t('recorded as a scheduled push', first.via === 'push');
  r = await changes();
  t('one upload has nothing to compare', r.code === 200 && r.body.comparison === null && /Only one/.test(r.body.note));

  console.log('— the same file again —');
  const same = toBook();
  r = await call(handlePlx, { method: 'POST', query: {}, body: { fileBase64: same }, get: h => (h === 'x-sync-key' ? 'k' : '') });
  // A fresh XLSX.write can differ in its zip timestamps, so send the stored bytes back.
  const stored = files['plx/history/' + first.id + '.xlsx'];
  r = await call(handlePlx, { method: 'POST', query: {}, body: { fileBase64: Buffer.from(stored).toString('base64') },
    get: h => (h === 'x-sync-key' ? 'k' : '') });
  t('identical bytes are not stored twice', r.body.sync.unchanged === true && r.body.sync.historyId === first.id);
  t('but the re-send is noted', !!index().find(x => x.id === first.id).lastSeenAt);
  const countBefore = index().length;

  console.log('— a changed upload —');
  r = await push({ newStart: true, newOrder: true, zStarted: true });
  t('compared as it lands', r.body.sync.changes.started === 1 && r.body.sync.changes.ordersCreated === 1 &&
    r.body.sync.changes.wtCompleted === 1);
  t('one more kept', index().length === countBefore + 1);

  r = await changes();
  t('the newest against the one before', r.code === 200 && r.body.comparison.changes.counts.started === 1);
  t('names who', r.body.comparison.changes.assignments.started[0].name === 'Nuevo, Ana');
  t('the uploads are listed with their changes', r.body.uploads.length === index().length &&
    r.body.uploads[r.body.uploads.length - 1].changes.started === 1);
  t('7 days', r.body.retentionDays === 7);

  r = await changes({ from: first.id, to: index()[index().length - 1].id });
  t('any two uploads', r.code === 200 && r.body.comparison.from.id === first.id);
  r = await changes({ from: 'nope' });
  t('an upload no longer kept is a 404', r.code === 404);
  r = await changes({ since: '2000-01-01T00:00:00Z' });
  t('a window past the history is marked partial', r.body.comparison.partial === true &&
    r.body.comparison.from.id === index()[0].id);

  console.log('— a market-scoped account —');
  auth.as({ markets: ['Joliet'], role: 'colleague' });
  r = await changes();
  t('sees only its buildings', r.body.comparison.changes.counts.started === 0 &&
    r.body.comparison.changes.counts.ordersCreated === 1);
  t('and no all-market counts per upload', r.body.uploads.every(u => u.changes === undefined));
  r = await changes({ download: first.id });
  t('cannot download the all-market file', r.code === 403 && r.body.forbidden);
  auth.as({ markets: [], role: 'viewer' });
  r = await changes({ download: first.id });
  t('nor can an account that cannot import', r.code === 403);
  auth.as({});
  r = await changes({ download: first.id });
  t('an unrestricted importer can', r.code === 200 && r.body.fileBase64 === Buffer.from(stored).toString('base64'));
  auth.as(null);
  t('signed out is refused', (await changes()).code === 401);
  auth.as({});

  console.log('— older than 7 days is pruned —');
  const aged = index().map((x, i) => Object.assign({}, x, { takenAt: '2026-01-0' + (i + 1) + 'T00:00:00Z' }));
  files[PLX_HISTORY_INDEX] = JSON.stringify({ entries: aged });
  r = await push({ filled: true });
  t('only the new upload and nothing stale remain', index().length === 1 && index()[0].id === r.body.sync.historyId);
  // 110150 filled, and 111000 -- added by the upload before -- gone again.
  t('it was still compared with the old newest', r.body.sync.changes && r.body.sync.changes.ordersClosed === 2);
  t('the old files are deleted', aged.every(x => !files['plx/history/' + x.id + '.xlsx'] && !files['plx/history/' + x.id + '.json']));

  console.log('— the headcount series and the profile —');
  const series = () => JSON.parse(files['plx/headcount-series.json']).points;
  t('every stored upload adds a reading', series().length >= 2);
  r = await changes();
  t('the profile is the newest upload', r.body.profile && r.body.profile.rows.length > 0 && r.body.profile.takenAt === index()[index().length - 1].takenAt);
  t('the trend is weekly', Array.isArray(r.body.trend) && r.body.trend.length >= 1 && r.body.trend[r.body.trend.length - 1].known);
  auth.as({ markets: ['Joliet'], role: 'colleague' });
  r = await changes();
  t('a scoped account gets only its sites in the profile', r.body.profile.rows.every(x => x.location === '1536'));
  t('and in the trend', r.body.trend.every(w => Object.keys(w.sites).every(loc => loc === '1536')));
  auth.as({});
  // The series is seeded from what is kept the first time it is written.
  delete files['plx/headcount-series.json'];
  const kept = index().length;
  await push({ newOrder: true, occurrence: true, qty: '9' });
  t('a missing series is seeded from the kept uploads', series().length === kept + 1);

  console.log('— a history failure does not fail the sync —');
  const save = bucket.file;
  bucket.file = k => (k.indexOf('plx/history/') === 0 && /xlsx$/.test(k)
    ? { save: async () => { throw new Error('disk full'); } } : save(k));
  r = await push({ occurrence: true });
  bucket.file = save;
  t('still a 200', r.code === 200);
  t('with a warning', r.body.sync.warnings.some(x => /7-day history/.test(x) && /disk full/.test(x)));

  console.log('— highlights from the real workbook, when present —');
  if (fs.existsSync(book)) {
    files = {};
    files[COLLECTIONS.locations.path] = JSON.stringify(LOCATIONS);
    r = await call(handlePlx, { method: 'POST', query: {}, body: { fileBase64: fs.readFileSync(book).toString('base64') },
      get: h => (h === 'x-sync-key' ? 'k' : '') });
    const snapReal = JSON.parse(files['plx/history/' + r.body.sync.historyId + '.json']);
    t('the server reads the highlight colours', snapReal.highlights === true);
    t('STARTED rows are blue: approved for start', Object.values(snapReal.candidates).filter(x => x.stage === 'started' && x.highlight === 'approved').length > 100);
    t('pipeline candidates highlighted green are accepted', Object.values(snapReal.candidates).some(x => x.stage === 'pipeline' && x.highlight === 'accepted'));
    r = await changes();
    t('one upload is enough for where things stand', r.body.comparison === null && r.body.profile.rows.length > 10);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})().catch(err => { console.error(err); process.exit(1); });
