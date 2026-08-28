/* The schedule the workbook already implies.

   The Key says what hours each shift runs and on which days; the HC tabs say
   which shift each associate is on. Between them the workbook states who is
   expected when, so coverage needs no separate weekly export. */
const fs = require('fs');
const path = require('path');
const SK = require('../shift-key.js');
const SC = require('../schedule-core.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

console.log('— day ranges —');
const dr = d => JSON.stringify(SK.parseDayRange(d));
t('Mon-Fri', dr('Mon-Fri') === '[1,2,3,4,5]');
t('Sun-Wed', dr('Sun-Wed') === '[0,1,2,3]');
t('Wed-Sat', dr('Wed-Sat') === '[3,4,5,6]');
t('a single day', dr('Wed') === '[3]');
t('Thur and Thurs both parse', dr('Sun-Thur') === '[0,1,2,3,4]' && dr('Sun-Thurs') === '[0,1,2,3,4]');
t('a range that wraps the weekend', dr('Fri-Mon') === '[5,6,0,1]');
t('"to" as a separator', dr('Mon to Fri') === '[1,2,3,4,5]');
t('nothing is not a week', dr('') === '[]' && dr('whenever') === '[]');
t('a whole week', dr('Sun-Sat') === '[0,1,2,3,4,5,6]');

console.log('— building a schedule from shift tags —');
const recs = [
  { name: 'Weekday, Wanda', nameKey: 'wanda weekday', shift: '1st', building: '1502', hours: '6am-2:30pm Mon-Fri' },
  { name: 'Weekend, Wes', nameKey: 'wes weekend', shift: 'A', building: '1519', hours: '6am-4:30pm Wed-Sat' },
  { name: 'Nights, Nadia', nameKey: 'nadia nights', shift: '3rd', building: '1502', hours: '6pm-2:30am Mon-Fri' },
  // 1517 does run a 1st shift -- this one proves it...
  { name: 'Early, Ed', nameKey: 'ed early', shift: '1st', building: '1517', hours: '6am-2:30pm Mon-Fri' },
  // ...so the Key giving no hours for this one is a real gap worth reporting.
  { name: 'Unknown, Ursula', nameKey: 'ursula unknown', shift: '1st', building: '1517', hours: '' },
  // Whereas 1517 runs no shift "5" at all: a typo, which validateAgainstKey
  // already reports. Counting it as a scheduling gap too would nag twice.
  { name: 'Typo, Tom', nameKey: 'tom typo', shift: '5', building: '1517', hours: '' }
];
// A Wednesday.
const sch = SK.scheduleFromShifts(recs, { asOf: new Date(2026, 7, 26), nameKeyOf: SC.nameKey });
t('only people with hours are scheduled', sch.people.length === 4);
t('a missing Key row for a shift the building runs is reported', sch.withoutHours.length === 1);
t('by name', sch.withoutHours[0].name === 'Unknown, Ursula');
t('and warned about', sch.warnings.length === 1 && sch.warnings[0].indexOf('1517 1st') !== -1);
t('a shift the building does not run is not reported twice',
  !sch.withoutHours.some(x => x.name === 'Typo, Tom') &&
  !sch.warnings.some(w => w.indexOf('"5"') !== -1 || w.indexOf('1517 5') !== -1));
t('flagged as derived, not uploaded', sch.derived === true);

const byKey = k => sch.people.filter(p => p.rosterKey === k)[0];
/* The join key matters: buildCoverage matches the schedule to the on-premise
   report on nameKey() -- the "last,first" WFM form -- while a shift record
   stores rosterKey(), the sorted cross-source form. Carrying the wrong one
   through here matches nobody at all, silently. */
t('the join key is the WFM form', byKey('wanda weekday').nameKey === SC.nameKey('Weekday, Wanda'));
t('and it differs from the roster form', byKey('wanda weekday').nameKey !== byKey('wanda weekday').rosterKey);
t('the roster form is kept too, for reaching a badge', byKey('wanda weekday').rosterKey === 'wanda weekday');
const wanda = byKey('wanda weekday');
const wed = '2026-08-26', sat = '2026-08-29', sun = '2026-08-23';
t('a weekday worker is on for Wednesday', !!wanda.shifts[wed]);
t('and off at the weekend', !wanda.shifts[sat] && !wanda.shifts[sun]);
t('with the right hours', wanda.shifts[wed].start === 360 && wanda.shifts[wed].end === 870);

const wes = byKey('wes weekend');
t('a Wed-Sat worker is on for Saturday', !!wes.shifts[sat]);
t('and off on Monday', !wes.shifts['2026-08-24']);

const nadia = byKey('nadia nights');
t('an overnight shift is marked as such', nadia.shifts[wed].overnight === true);
t('and rolls past midnight', nadia.shifts[wed].end > 1440);

console.log('— it covers the days a coverage check needs —');
t('a full week plus a day either side', sch.dates.length === 9);
t('so yesterday is available for an overnight shift', sch.dates.indexOf('2026-08-25') !== -1);

console.log('— it feeds buildCoverage unchanged —');
const presence = SC.parseOnPremise([
  ['Employee Full Name & ID', 'On Premises', 'Primary location (path)', 'Reports To'],
  ['Weekday, Wanda (80-W1)', 'true', 'GEODIS/US/CL/CL1502/1502', 'B, B'],
  ['Nights, Nadia (80-N1)', 'false', 'GEODIS/US/CL/CL1502/1502', 'B, B']
]);
const res = SC.buildCoverage({ schedule: sch, presence: presence, asOf: new Date(2026, 7, 26, 9, 0) });
const byName = n => res.rows.filter(r => r.name === n)[0];
t('the weekday worker reads as working at 9am', byName('Weekday, Wanda').status === 'working');
t('the night worker is not yet due', byName('Nights, Nadia').status === 'scheduled');
t('and is not called an exception', byName('Nights, Nadia').severity !== 'bad');
// Wes is Wed-Sat and this is a Wednesday, so he is on shift and not on the
// clock -- exactly the exception a derived schedule is supposed to catch.
t('a scheduled absence is caught from the workbook alone', byName('Weekend, Wes').status === 'missing');
// Wanda, Wes and Ed are all on shift on a Wednesday morning; only Wanda is on
// the clock. Ed is absent from the on-premise file entirely, which counts the
// same way -- not being in the report is not evidence of being at work.
t('onShift counts every day worker', res.summary.onShift === 3);
t('coverage counts both absences against it', res.summary.coverage === 33);

console.log('— against the real workbook, when present —');
const book = path.join(__dirname, '..', 'PLX - Geodis Spreadsheet.xlsx');
if (!fs.existsSync(book)) {
  console.log('  skipped - workbook not in the repo');
} else {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(book);
  const rd = n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' });
  const sheets = wb.SheetNames.map(n => ({ name: n, aoa: rd(n) }));
  const key = SK.parseShiftKey(sheets.filter(x => SK.KEY_SHEET.test(x.name))[0].aoa);
  const real = SK.toShiftRecords(SK.parseHeadcount(sheets, SC.rosterKey), key);
  const realSch = SK.scheduleFromShifts(real, { asOf: new Date(2026, 7, 26), nameKeyOf: SC.nameKey });
  /* The account number narrows the hours, so only rows the Key cannot be reached
     from are left unscheduled -- 1, not the 37 that building+shift alone left.
     Two mistyped dept codes are read through ACCOUNT_ALIASES (18070 -> Replay's
     18270, 18873 -> 3 Nails' 18773); what remains is a row with no dept at all,
     which nothing can narrow. */
  t('313 of the 314 tagged associates can be scheduled', realSch.people.length === 313);
  /* The one left is tagged with a shift 1517 does not run. validateAgainstKey
     already reports that as a typo, so it is not counted here as well. */
  t('and the last is a bad shift value, reported as a typo instead',
    realSch.withoutHours.length === 0);
  t('the alias is what schedules the 18070 pair',
    SK.scheduleFromShifts(
      real.map(r => Object.assign({}, r, { hours: r.account === 'REPLAY' ? '' : r.hours })),
      { asOf: new Date(2026, 7, 26), nameKeyOf: SC.nameKey }
    ).people.length < realSch.people.length);
  t('with no scheduling gap left to warn about', realSch.warnings.length === 0);
  t('everyone scheduled has at least one day', realSch.people.every(p => Object.keys(p.shifts).length > 0));
}

console.log('— matching the on-premise report by employee id —');
{
  // The workbook and WFM disagree about which word is the surname. Same person.
  const sch = SK.scheduleFromShifts([
    { name: 'Meneses Arias, Kevin', nameKey: 'kevin menesesarias', eid: '80-KARIAS9617',
      shift: '1st', building: '1502', hours: '6am-2:30pm Mon-Fri' },
    { name: 'Fernandez, Naibelys', nameKey: 'fernandez naibelys', eid: '80-FNAIBE9109',
      shift: '1st', building: '1502', hours: '6am-2:30pm Mon-Fri' }
  ], { asOf: new Date(2026, 7, 26), nameKeyOf: SC.nameKey });
  t('the derived schedule carries the employee id', sch.people.every(p => !!p.eid));

  const pres = SC.parseOnPremise([
    ['Employee Full Name & ID', 'On Premises', 'Primary location (path)', 'Reports To'],
    ['Arias, Kevin (80-KARIAS9617)', 'true', 'GEODIS/US/CL/CL1502/1502', 'B, B'],
    ['Naibelys, Fernandez (80-FNAIBE9109)', 'true', 'GEODIS/US/CL/CL1502/1502', 'B, B']
  ]);
  const idx = SC.presenceIndex(pres);
  t('neither name matches on its own',
    !idx.byName.has(SC.nameKey('Meneses Arias, Kevin')) &&
    !idx.byName.has(SC.nameKey('Fernandez, Naibelys')));
  t('but the employee id finds both', sch.people.every(p => !!idx.find(p)));

  const res = SC.buildCoverage({ schedule: sch, presence: pres, asOf: new Date(2026, 7, 26, 9, 0) });
  t('so they are counted as working, not as two rows each', res.rows.length === 2);
  t('and coverage is whole', res.summary.coverage === 100);
  t('nobody is left over as unscheduled', res.summary.byStatus.unscheduled === 0);
}

console.log('— the name is still the fallback —');
{
  // An uploaded WFM schedule export identifies people by badge and carries no
  // employee id at all, so the name has to keep working.
  const sch = { people: [{ name: 'Weekday, Wanda', nameKey: 'weekday,wanda', badge: '236413',
    shifts: { '2026-08-26': { raw: '6:00 AM - 2:30 PM', start: 360, end: 870, overnight: false } } }] };
  const pres = SC.parseOnPremise([
    ['Employee Full Name & ID', 'On Premises', 'Primary location (path)', 'Reports To'],
    ['Weekday, Wanda (80-W1)', 'true', 'GEODIS/US/CL/CL1502/1502', 'B, B']
  ]);
  const res = SC.buildCoverage({ schedule: sch, presence: pres, asOf: new Date(2026, 7, 26, 9, 0) });
  t('a schedule with no employee ids still matches on name', res.summary.coverage === 100);
  t('and does not double-count', res.rows.length === 1);
}

console.log('— an id that matches nothing does not fall back onto a wrong name —');
{
  const sch = SK.scheduleFromShifts([
    { name: 'Smith, John', nameKey: 'john smith', eid: '80-JSMITH0001',
      shift: '1st', building: '1502', hours: '6am-2:30pm Mon-Fri' }
  ], { asOf: new Date(2026, 7, 26), nameKeyOf: SC.nameKey });
  const pres = SC.parseOnPremise([
    ['Employee Full Name & ID', 'On Premises', 'Primary location (path)', 'Reports To'],
    ['Smith, John (80-JSMITH9999)', 'true', 'GEODIS/US/CL/CL1502/1502', 'B, B']
  ]);
  // Two different employee ids, same name. The name is a fallback, not a
  // contradiction of the id -- these really are the same person by name, and
  // nothing better is on offer, so the fallback is allowed to match.
  const res = SC.buildCoverage({ schedule: sch, presence: pres, asOf: new Date(2026, 7, 26, 9, 0) });
  t('an unmatched id falls back to the name rather than dropping the person',
    res.rows.length === 1 && res.rows[0].status === 'working');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
