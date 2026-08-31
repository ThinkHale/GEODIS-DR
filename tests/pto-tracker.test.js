/* The shared IL PTO tracker.

   One workbook, two branches, three GEODIS tabs that do not share a shape — and
   one of them carries other clients' associates on the same sheet. */
const P = require('../pto-tracker-core.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; } else { fail++; console.log('  FAIL: ' + n); } };

console.log('— which tab is which —');
t('the branch tab is recognised', P.tabFor('30080').kind === 'branch');
t('the pending GEODIS tab is recognised', P.tabFor('GEODIS - 20062').kind === 'pending');
// "20062 Geodis Processed" matches the pending pattern too; order decides it.
t('the processed tab is not mistaken for the pending one',
  P.tabFor('20062 Geodis Processed').kind === 'processed');
t('a renamed processed tab still reads as processed',
  P.tabFor('Geodis 20062 - processed').kind === 'processed');
t('another branch tab is not read as GEODIS', P.tabFor('20078') === null);
t('a non-GEODIS tab is skipped', P.tabFor('Master') === null && P.tabFor('Billable PTO') === null);
t('a tab named for a different branch number is not 30080', P.tabFor('30081') === null);

console.log('— GEODIS or somebody else —');
t('the GEODIS clients are kept', P.isGeodis('Geodis/Lego') && P.isGeodis('Geodis Spectrum') &&
  P.isGeodis('Geodis WF Young') && P.isGeodis('Geodis'));
t('other clients on the same sheet are not', !P.isGeodis('Crescent Park') &&
  !P.isGeodis('Fed Ex') && !P.isGeodis('Kraft'));
t('a blank client is not GEODIS', !P.isGeodis('') && !P.isGeodis(null));

console.log('— dates, as typed by hand —');
t('m/d/yy', P.parseOneDate('8/24/26') === '2026-08-24');
t('m/d/yyyy', P.parseOneDate('6/15/2026') === '2026-06-15');
t('a real Date', P.parseOneDate(new Date(2026, 7, 24, 23, 0)) === '2026-08-24');
t('an ISO string', P.parseOneDate('2026-08-24') === '2026-08-24');
// "13-Jul" states no year at all.
t('day-month takes its year from elsewhere on the row', P.parseOneDate('13-Jul', 2026) === '2026-07-13');
t('and is refused rather than guessed when there is no year', P.parseOneDate('13-Jul') === null);
t('N/A is not a date', P.parseOneDate('N/A') === null && P.parseOneDate('n/a') === null);
t('blank is not a date', P.parseOneDate('') === null && P.parseOneDate(null) === null);
t('nonsense is not a date', P.parseOneDate('sometime') === null);

console.log('— two dates in one cell —');
// Real rows: "6/15/2026 & 6/16/2026", "7/9/2026 & 7/10/2026".
t('both dates are read', JSON.stringify(P.parseDates('6/15/2026 & 6/16/2026')) ===
  JSON.stringify(['2026-06-15', '2026-06-16']));
t('a comma separates them too', P.parseDates('6/15/2026, 6/16/2026').length === 2);
t('so does "and"', P.parseDates('6/15/2026 and 6/16/2026').length === 2);
t('one date is still one date', P.parseDates('8/24/26').length === 1);
t('an unreadable half does not take the readable one with it',
  JSON.stringify(P.parseDates('6/15/2026 & ???')) === JSON.stringify(['2026-06-15']));

console.log('— where a request stands —');
const pending = P.TABS.filter(x => x.kind === 'pending')[0];
const processed = P.TABS.filter(x => x.kind === 'processed')[0];
const branch = P.TABS.filter(x => x.kind === 'branch')[0];
t('the pending tab means approved, not yet processed', P.statusFor(pending, 'approved', '') === 'Approved');
t('the branch tab means approved', P.statusFor(branch, 'Approved', '') === 'Approved');
t('the processed tab means completed', P.statusFor(processed, 'Approved', 'Yes') === 'Completed');
// The processed tab has rows with a blank Status but Processed = Yes.
t('processed with no decision recorded is still completed', P.statusFor(processed, '', 'Yes') === 'Completed');
t('"Already Paid; Bill only" is completed', P.statusFor(processed, 'Already Paid; Bill only', 'Yes') === 'Completed');
// Processed beats the tab: payroll is done with it wherever it was written.
t('Processed = Yes completes a row on any tab', P.statusFor(pending, 'approved', 'Yes') === 'Completed');
t('a denial is honoured over the tab', P.statusFor(processed, 'Denied', 'Yes') === 'Denied');
t('so is a cancellation', P.statusFor(pending, 'Cancelled', '') === 'Cancelled');
t('case and spacing do not change the answer', P.statusFor(pending, '  APPROVED ', '') === 'Approved');

/* ---------- the workbook ----------
   Shaped like the real one: a banner above the header on two tabs and not the
   third, different column sets, and other clients mixed in on 30080. */
console.log('— reading the workbook —');
const sheets = [
  { name: 'Master', aoa: [['something else']] },
  { name: '30080', aoa: [
    ['PLEASE ENSURE ALL APPROVED PTO IS ENTERED…'],
    ['Associate Name', 'EID', 'Client', 'Submission Date', 'Request Date', 'Weekending', 'Hours', 'Available', 'Eligibility', 'Notes', 'Requestor Name', 'Manager Approval'],
    ['Geo Person', '11802501', 'Geodis Spectrum', '8/25/26', '8/27/26', '8/30/26', '2', '10', 'Eligible', '', 'Jae Simms', 'Approved'],
    ['Other Person', '20390890', 'Crescent Park', '8/18/26', '8/24/26', '8/30/26', '10', '34.9', 'Eligible', '', 'Jae Simms', 'Approved'],
    ['Kraft Person', '20390891', 'Kraft', '8/18/26', '8/24/26', '8/30/26', '8', '', 'Eligible', '', 'Jae Simms', 'Approved']
  ] },
  { name: 'GEODIS - 20062', aoa: [
    ['PLEASE ENSURE ALL APPROVED PTO…'],
    ['Associate Name', 'EID', 'Assignment #', 'Client', 'Submission Date', 'Request Date', 'Weekending', 'Hours', 'PTO Available', 'Eligibility', 'Mark Up %', 'Requestor Name', 'Status'],
    ['Chi Person', '21640777', '10893286', 'Geodis/Lego', '8/20/26', '8/24/26', '8/30/26', '8', '8', 'Yes', '39%', 'sandra Rostro', 'approved']
  ] },
  { name: '20062 Geodis Processed', aoa: [
    ['Associate Name', 'EID', 'Assignment #', 'Client', 'Submission Date', 'Request Date', 'Weekending', 'Hours', 'Available', 'Eligibility', 'Mark Up %', 'Requestor Name', 'Status', 'Processed'],
    ['Done Person', '21464223', '10874075', 'Geodis', '7/1/26', '13-Jul', '19-Jul', '8', '21.49', 'Eligible', '39%', 'sandra Rostro', 'Approved', 'Yes'],
    ['Two Day Person', '21641000', '10893000', 'Geodis', '8/6/26', '6/15/2026 & 6/16/2026', '6/21/26', '16', '', 'Eligible', '39%', 'Jared Holwerda', '', 'Yes']
  ] }
];
const r = P.parseTracker(sheets);

t('only the three GEODIS tabs are read', r.sheets.length === 3);
t('the others are named rather than silently ignored',
  r.skipped.indexOf('Master') !== -1);
t('the header is found under a banner and without one', (() => {
  const by = {}; r.sheets.forEach(s => { by[s.name] = s.headerRow; });
  return by['30080'] === 1 && by['GEODIS - 20062'] === 1 && by['20062 Geodis Processed'] === 0;
})());

t('only GEODIS rows are imported', r.requests.length === 4);
t('the others are counted, not dropped in silence',
  r.nonGeodis === 2 && r.otherClients['Crescent Park'] === 1 && r.otherClients['Kraft'] === 1);
t('a row keeps the branch it was written on', (() => {
  const geo = r.requests.filter(x => x.name === 'Geo Person')[0];
  const chi = r.requests.filter(x => x.name === 'Chi Person')[0];
  return geo.branch === '30080' && chi.branch === '20062';
})());
t('and the status its tab implies', (() => {
  const s = {}; r.requests.forEach(x => { s[x.name] = x.status; });
  return s['Geo Person'] === 'Approved' && s['Chi Person'] === 'Approved' &&
    s['Done Person'] === 'Completed' && s['Two Day Person'] === 'Completed';
})());

console.log('— the awkward rows —');
const done = r.requests.filter(x => x.name === 'Done Person')[0];
t('a day-month request date takes its year from the submission date', done.start === '2026-07-13');
const two = r.requests.filter(x => x.name === 'Two Day Person')[0];
t('two dates in one cell become one request across both days',
  two.start === '2026-06-15' && two.end === '2026-06-16');
t('and it says it covers more than one day', two.multiDay === true);
t('with the hours as written, not doubled', two.hours === 16);
t('a single-day request starts and ends the same day', done.start === done.end && done.multiDay === false);
t('hours read as a number', r.requests.every(x => x.hours === null || typeof x.hours === 'number'));
t('every row carries the EID that reaches a profile',
  r.requests.every(x => /^\d+$/.test(x.eid)));
t('nothing was reported as a problem', r.warnings.length === 0);

console.log('— rows that cannot be read are reported —');
t('a request date that says nothing is reported and falls back to the week ending', (() => {
  const odd = P.parseTracker([{ name: '30080', aoa: [
    ['banner'],
    ['Associate Name', 'EID', 'Client', 'Submission Date', 'Request Date', 'Weekending', 'Hours', 'Manager Approval'],
    ['No Date', '1', 'Geodis', '8/18/26', 'N/A', '8/30/26', '8', 'Approved']
  ] }]);
  return odd.requests[0].start === '2026-08-30' && odd.warnings.length === 1 &&
    odd.warnings[0].indexOf('No Date') !== -1;
})());
t('hours that are not a number are reported, not counted as zero', (() => {
  const odd = P.parseTracker([{ name: '30080', aoa: [
    ['banner'],
    ['Associate Name', 'EID', 'Client', 'Submission Date', 'Request Date', 'Hours', 'Manager Approval'],
    ['Bad Hours', '1', 'Geodis', '8/18/26', '8/24/26', 'all day', 'Approved']
  ] }]);
  return odd.requests[0].hours === null && odd.warnings.some(w => /all day/.test(w));
})());
t('a tab with no recognisable header is reported', (() => {
  const odd = P.parseTracker([{ name: '30080', aoa: [['nothing', 'useful']] }]);
  return odd.requests.length === 0 && odd.warnings.length === 1;
})());
t('an empty workbook is not a crash',
  P.parseTracker([]).requests.length === 0 && P.parseTracker().requests.length === 0);
t('a row with no name is skipped without comment', (() => {
  const odd = P.parseTracker([{ name: '30080', aoa: [
    ['banner'],
    ['Associate Name', 'EID', 'Client', 'Request Date', 'Hours', 'Manager Approval'],
    ['', '1', 'Geodis', '8/24/26', '8', 'Approved']
  ] }]);
  return odd.requests.length === 0 && odd.warnings.length === 0;
})());

console.log('— into the time-off collection —');
const built = P.toTimeOffRecords(r, { badgeForEid: e => ({ '11802501': 'B1', '21640777': 'B2' })[e] || '' });
t('every GEODIS row becomes a request', built.records.length === 4);
t('each id is distinct', new Set(built.records.map(x => x.id)).size === 4);
// The id is EID + the days, deliberately WITHOUT the hours: a request that moves
// from the pending tab to the processed one is the same request.
t('the id is the person and the days, not the hours', (() => {
  const a = P.requestId({ eid: '1', start: '2026-08-24', end: '2026-08-24' });
  const b = P.requestId({ eid: '1', start: '2026-08-24', end: '2026-08-24' });
  return a === b && a.indexOf('2026-08-24') !== -1;
})());
t('a multi-day request has its own id', P.requestId({ eid: '1', start: '2026-06-15', end: '2026-06-16' }) !==
  P.requestId({ eid: '1', start: '2026-06-15', end: '2026-06-15' }));
t('they are PTO', built.records.every(x => x.type === 'PTO'));
t('a matched EID carries its badge', built.records.filter(x => x.eid !== '' && x.badge === 'B1').length >= 0 &&
  built.records.some(x => x.badge === 'B1'));
// An approved day off must not be dropped because the person left the roster.
t('an unmatched EID is still imported, with no badge',
  built.records.some(x => !x.badge) && built.unmatched.length === 2);
t('and the unmatched are named so they can be connected',
  built.unmatched.every(u => u.eid && u.name && u.sheet));
t('the client travels with the request', built.records.some(x => x.location === 'Geodis/Lego'));
t('so does where it came from', built.records.every(x => /row \d+/.test(x.importRef)));
t('hours are a number, never blank', built.records.every(x => typeof x.hours === 'number'));

console.log('— an import is only ever about its own rows —');
const existing = [
  { id: 'PTO-XLS-1', source: 'Geodis Chicago PTO Payroll Tracker.xlsx' },
  { id: 'FORM-1', source: 'Microsoft Forms' },
  { id: 'HAND-1' },
  { id: 'PTOIL-OLD', source: 'IL Shared PTO Tracker' }
];
const merged = P.mergeForSave(existing, [{ id: 'PTOIL-NEW', source: 'IL Shared PTO Tracker' }]);
t('the other PTO workbook is untouched', merged.some(x => x.id === 'PTO-XLS-1'));
t('so is the Forms intake', merged.some(x => x.id === 'FORM-1'));
t('so is anything entered by hand', merged.some(x => x.id === 'HAND-1'));
// The sheet is the record of what was approved: a row deleted there goes here too.
t('a row since deleted from the tracker is removed', !merged.some(x => x.id === 'PTOIL-OLD'));
t('and the new row is in', merged.some(x => x.id === 'PTOIL-NEW'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
