/* Export for the GEODIS headcount spreadsheet. The column contract is verified
   against the real workbook when it is present, so a layout change in the sheet
   fails here rather than silently producing a misaligned paste. */
const fs = require('fs');
const path = require('path');
const SC = require('../schedule-core.js');

let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

console.log('— shift labels (per the "Geodis Key" schedules) —');
const lbl = raw => SC.shiftLabel(SC.parseShiftRange(raw).start);
t('6am-2:30pm  -> 1st', lbl('6:00 AM - 2:30 PM') === '1st');
t('7am-3:30pm  -> 1st', lbl('7:00 AM - 3:30 PM') === '1st');
t('3pm-11:30pm -> 2nd', lbl('3:00 PM - 11:30 PM') === '2nd');
t('9:30pm-6am  -> 3rd', lbl('9:30 PM - 6:00 AM') === '3rd');
t('no shift -> no label', SC.shiftLabel(null) === '');

console.log('— start dates match the sheet format —');
t('4-digit year shortened', SC.shortDate('5/28/2026') === '5/28/26');
t('already short is left alone', SC.shortDate('5/28/26') === '5/28/26');
t('non-dates pass through', SC.shortDate('') === '' && SC.shortDate('n/a') === 'n/a');

console.log('— building a branch block —');
const scheduleAoa = [
  ['Time Period :', '', '8/23/2026 - 8/29/2026'],
  ['GEODIS/US/CL/CLSCEN/CLSL/CL1502/1502'],
  ['Employee', 'Primary Job', 'Mon', 'Tue'],
  ['', '', '8/24/2026', '8/25/2026'],
  ['Grachen, Luz', 'OPR2', '6:00 AM - 2:30 PM', '6:00 AM - 2:30 PM'],
  ['Porras, Fernando', 'OPR2', '6:00 AM - 2:30 PM', '6:00 AM - 2:30 PM'],
  ['Munoz, Abel', 'MATH1', '3:00 PM - 11:30 PM', '3:00 PM - 11:30 PM'],
  ['Cruz, Guadalupe', 'OPR2', 'PTO', 'PTO']
];
const onPremAoa = [
  ['Employee Full Name & ID', 'On Premises', 'Primary location', 'Reports To'],
  ['Grachen, Luz (80-LGRACH3897)', 'true', 'GEODIS/US/CL/CLSCEN/CLSL/CL1502/1502', 'Pickett, Craig'],
  ['Porras, Fernando (80-FPORRA4387)', 'false', 'GEODIS/US/CL/CLSCEN/CLSL/CL1502/1502', 'Pickett, Craig'],
  ['Munoz, Abel (80-AMUNOZ8734)', 'true', 'GEODIS/US/CL/CLSCEN/CLSL/CL1502/1502', 'Sotelo, Marco'],
  ['Cruz, Guadalupe (87-GCRUZ9770)', 'false', 'GEODIS/US/CL/CLSCEN/CLSL/CL1502/1502', 'Pickett, Craig']
];
const schedule = SC.parseSchedule(scheduleAoa);
const presence = SC.parseOnPremise(onPremAoa);
// Roster names are "First Last" -- the reverse of the WFM reports, which is what
// rosterKey() exists to bridge.
const profiles = new Map([
  ['80-LGRACH3897', { badge: '80-LGRACH3897', name: 'Luz Grachen', crmStart: '5/28/2026', points: 2 }],
  ['80-FPORRA4387', { badge: '80-FPORRA4387', name: 'Fernando Porras', crmStart: '6/4/2026', points: 0 }],
  ['80-AMUNOZ8734', { badge: '80-AMUNOZ8734', name: 'Abel Munoz', crmStart: '6/9/2026', points: 0 }]
]);
const asOf = new Date(2026, 7, 25, 9, 0, 0);   // Tue 25 Aug, 9:00 -- 1st shift running
const res = SC.buildCoverage({ schedule, presence, asOf });
SC.linkRoster(res.rows, profiles, v => String(v || '').trim());

const first = SC.spreadsheetExport(res, { location: '1502', shift: '1st', profiles, documented: {} });
t('columns match the sheet exactly', JSON.stringify(first.columns) ===
  JSON.stringify(['Employee  Name', 'EID', 'Start Date', 'Shift', 'Current Points', 'Comments']));
t('only 1st shift rows', first.rows.length === 2);
t('2nd shift excluded', !first.rows.some(r => r.name === 'Munoz, Abel'));
t('PTO row has no shift, so no block', !first.rows.some(r => r.name === 'Cruz, Guadalupe'));
t('rows sorted by name', first.rows[0].name === 'Grachen, Luz');
const luz = first.rows[0];
t('name kept in "Last, First"', luz.name === 'Grachen, Luz');
t('EID is the WFM id', luz.eid === '80-LGRACH3897');
t('start date in sheet format', luz.startDate === '5/28/26');
t('shift label', luz.shift === '1st');
t('points from attendance', luz.points === 2);
t('present person gets a blank comment', luz.comments === '');
const fern = first.rows[1];
t('absent person is flagged in Comments', fern.comments === 'Not clocked in');
t('absent person still listed in headcount', fern.name === 'Porras, Fernando');

console.log('— Expected / Onsite / Short —');
t('expected counts the block', first.summary.expected === 2);
t('onsite counts who is here', first.summary.onsite === 1);
t('short is the difference', first.summary.short === 1);
const second = SC.spreadsheetExport(res, { location: '1502', shift: '2nd', profiles, documented: {} });
t('2nd shift block is its own count', second.summary.expected === 1 && second.summary.onsite === 1);
t('a fully covered shift is short 0', second.summary.short === 0);

console.log('— documented reasons reach the Comments cell —');
const documented = {};
documented[SC.personKey({ badge: '80-FPORRA4387' })] =
  { disposition: 'Called in', reason: 'car trouble' };
const withDoc = SC.spreadsheetExport(res, { location: '1502', shift: '1st', profiles, documented });
t('documentation overrides the status label',
  withDoc.rows.find(r => r.name === 'Porras, Fernando').comments === 'Called in - car trouble');

console.log('— roster join across name orders (the bug rosterKey fixes) —');
t('"Luz Grachen" and "Grachen, Luz" are one person',
  SC.rosterKey('Luz Grachen') === SC.rosterKey('Grachen, Luz'));
t('middle names do not break it', SC.rosterKey('Grachen, Luz M') === SC.rosterKey('Luz Grachen'));
t('different people stay different', SC.rosterKey('Luz Grachen') !== SC.rosterKey('Luz Porras'));
// Cruz has no roster profile, so nothing should be invented for her.
const all = SC.spreadsheetExport(res, { location: '1502', shift: 'all', profiles, documented: {} });
t('unrostered person exports with blank start/points',
  !all.rows.some(r => r.startDate === undefined));

console.log('— TSV for pasting —');
const tsv = SC.toTsv(first, false);
const lines = tsv.split('\n');
t('no header row (the block already has one)', lines[0].indexOf('Employee') === -1);
t('one line per row', lines.length === 2);
t('six tab-separated cells', lines[0].split('\t').length === 6);
t('cells in sheet order', lines[0].split('\t')[1] === '80-LGRACH3897');
t('header can be requested', SC.toTsv(first, true).split('\n')[0].split('\t')[0] === 'Employee  Name');
t('tabs/newlines in a comment cannot break the paste',
  SC.toTsv({ columns: first.columns, rows: [{ name: 'A\tB', eid: '', startDate: '', shift: '', points: '', comments: 'x\ny' }] }, false)
    .split('\n').length === 1);

console.log('— contract against the real workbook —');
const bookPath = path.join(__dirname, '..', 'PLX - Geodis Spreadsheet.xlsx');
if (!fs.existsSync(bookPath)) {
  console.log('  skipped - workbook not in the repo');
} else {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(bookPath);
  const hcSheets = wb.SheetNames.filter(n => /HC$/.test(n));
  t('HC sheets found', hcSheets.length > 0);
  let checked = 0;
  hcSheets.forEach(n => {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' });
    const headers = (aoa[1] || []).map(h => String(h).trim());
    // Our six columns must appear contiguously, in order, in every branch sheet.
    const start = headers.findIndex(h => /^Employee\s+Name$/i.test(h));
    if (start === -1) { t(n + ': has an Employee Name column', false); return; }
    const slice = headers.slice(start, start + 6).map(h => h.replace(/\s+/g, ' '));
    const want = SC.SHEET_COLUMNS.map(h => h.replace(/\s+/g, ' '));
    t(n + ': six columns align', JSON.stringify(slice) === JSON.stringify(want));
    checked++;
  });
  t('every HC sheet checked', checked === hcSheets.length);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
