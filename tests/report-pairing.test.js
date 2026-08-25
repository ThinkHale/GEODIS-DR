/* Pairing the two WFM reports. Both are exported per site, so a schedule for one
   site against an on-premise pull for another produces a confident, catastrophic
   0% -- every scheduled person reads as absent simply because they are not in the
   other file. That has to be detected, not reported as a coverage failure. */
const SC = require('../schedule-core.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const sched = (site, names) => SC.parseSchedule([
  ['Time Period :', '', '8/23/2026 - 8/29/2026'],
  ['GEODIS/US/CL/CLSCEN/CLSL/CL' + site + '/' + site],
  ['Employee', 'Primary Job', 'Tue'],
  ['', '', '8/25/2026']
].concat(names.map(n => [n, 'Job', '7:00 AM - 3:30 PM'])));
const onprem = (site, rows) => SC.parseOnPremise([
  ['Employee Full Name & ID', 'On Premises', 'Primary location (path)', 'Reports To']
].concat(rows.map(r => [r[0] + ' (80-' + r[0].replace(/\W/g, '').slice(0, 6).toUpperCase() + '1)', r[1],
  'GEODIS/US/CL/CLSCEN/CLSL/CL' + site + '/' + site, 'Boss, A'])));
const asOf = new Date(2026, 7, 25, 9, 0);

console.log('— the punch column —');
const p = onprem('1523', [['Reed, Ava', 'true'], ['Nash, Cleo', 'false'], ['Ortiz, Ben', 'TRUE'], ['Kim, Eve', 'False']]);
t('true means punched in', p.people[0].present === true);
t('false means not punched in', p.people[1].present === false);
t('uppercase TRUE parses', p.people[2].present === true);
t('mixed-case False parses', p.people[3].present === false);
t('everyone active is listed, punched in or not', p.people.length === 4);

console.log('— a correctly paired set —');
const good = SC.buildCoverage({
  schedule: sched('1523', ['Reed, Ava', 'Nash, Cleo', 'Ortiz, Ben']),
  presence: onprem('1523', [['Reed, Ava', 'true'], ['Nash, Cleo', 'false'], ['Ortiz, Ben', 'true']]),
  asOf
});
t('not flagged as a mismatch', good.mismatch === false);
t('every scheduled person accounted for', good.overlap.matched === 3);
t('working counts the punched-in', good.summary.byStatus.working === 2);
t('missing counts the rest', good.summary.byStatus.missing === 1);
t('coverage is a real number', good.summary.coverage === 67);
t('no pairing warning', !good.warnings.some(w => w.indexOf('different sites') !== -1));

console.log('— the reported bug: two different sites —');
const bad = SC.buildCoverage({
  schedule: sched('1519', ['Chi, Ann', 'Chi, Bob', 'Chi, Cal']),
  presence: onprem('1523', [['Reed, Ava', 'true'], ['Nash, Cleo', 'false']]),
  asOf
});
t('flagged as a mismatch', bad.mismatch === true);
t('nothing overlapped', bad.overlap.matched === 0);
t('coverage is null, NOT a confident 0%', bad.summary.coverage === null);
t('the schedule sites are named', JSON.stringify(bad.overlap.scheduleSites) === '["1519"]');
t('the on-premise sites are named', JSON.stringify(bad.overlap.presenceSites) === '["1523"]');
const warn = bad.warnings[0];
t('warning leads the list', warn.indexOf('None of the 3 scheduled people') === 0);
t('warning names both site sets', warn.indexOf('1519') !== -1 && warn.indexOf('1523') !== -1);
t('warning says what to do', warn.indexOf('same site') !== -1);

console.log('— partial overlap still reports, but says so —');
const partial = SC.buildCoverage({
  schedule: sched('1523', ['Reed, Ava', 'Chi, Ann', 'Chi, Bob', 'Chi, Cal']),
  presence: onprem('1523', [['Reed, Ava', 'true']]),
  asOf
});
t('not a hard mismatch', partial.mismatch === false);
t('coverage is still reported', partial.summary.coverage !== null);
t('but the shortfall is flagged', partial.warnings.some(w => w.indexOf('Only 1 of 4') === 0));
t('and explains the effect on the number',
  partial.warnings[0].indexOf('counted as not clocked in') !== -1);

console.log('— edges —');
t('no schedule loaded is not a mismatch',
  SC.buildCoverage({ schedule: { people: [], dates: [] }, presence: onprem('1523', [['Reed, Ava', 'true']]), asOf }).mismatch === false);
t('no on-premise loaded is not a mismatch',
  SC.buildCoverage({ schedule: sched('1523', ['Reed, Ava']), presence: { people: [] }, asOf }).mismatch === false);
t('neither loaded is not a mismatch',
  SC.buildCoverage({ schedule: { people: [], dates: [] }, presence: { people: [] }, asOf }).mismatch === false);

console.log('— against the real St. Louis reports, when present —');
const fs = require('fs'), path = require('path');
const D = path.join(process.env.HOME, 'Downloads');
const ON = '_Report Output_On Premise - Simple_x-chale_2026-08-25T11_12_00.521.csv';
const STL = '_Report Output_employee_schedule_weekly_x-chale_2026-08-25T12_02_11.489.xlsx';
const CHI = '_Report Output_employee_schedule_weekly_x-ebolingbrook_2026-08-25T13_21_53.656.xlsx';
if (![ON, STL, CHI].every(f => fs.existsSync(path.join(D, f)))) {
  console.log('  skipped - source reports not in ~/Downloads');
} else {
  const XLSX = require('xlsx');
  const rd = f => { const wb = XLSX.readFile(path.join(D, f)); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' }); };
  const pres = SC.parseOnPremise(rd(ON));
  const realAsOf = SC.asOfFromFileName(ON);
  t('on-premise parses', pres.people.length === 117);
  t('53 were punched in', pres.people.filter(x => x.present).length === 53);
  t('as-of read from the file name', SC.isoDateTime(realAsOf) === '2026-08-25T11:12:00');

  const stl = SC.buildCoverage({ schedule: SC.parseSchedule(rd(STL)), presence: pres, asOf: realAsOf });
  t('St. Louis schedule pairs cleanly', stl.mismatch === false && stl.overlap.matched === 95);
  t('and yields a real coverage figure', stl.summary.coverage === 65);
  t('47 working', stl.summary.byStatus.working === 47);
  t('25 not clocked in', stl.summary.byStatus.missing === 25);
  t('the 20.5-hour shift is flagged as suspect',
    stl.warnings.some(w => w.indexOf('20.5 hours') !== -1));

  const chi = SC.buildCoverage({ schedule: SC.parseSchedule(rd(CHI)), presence: pres, asOf: realAsOf });
  t('Chicago schedule vs St. Louis on-premise is caught', chi.mismatch === true);
  t('no coverage invented from it', chi.summary.coverage === null);
  t('both real site sets named',
    chi.overlap.scheduleSites.indexOf('1519') !== -1 && chi.overlap.presenceSites.indexOf('1523') !== -1);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
