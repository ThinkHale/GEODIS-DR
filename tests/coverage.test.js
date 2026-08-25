/* Schedule vs. on-premise coverage (schedule-core.js). */
const C = require('../schedule-core.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; } else { fail++; console.log('  FAIL: ' + n); } };

/* ---------- parsing primitives ---------- */
console.log('— names —');
t('"Last, First" keys on letters only', C.nameKey('O\'Brian, Jason') === 'obrian,jason');
t('case and spacing collapse', C.nameKey('lynch, dominque') === C.nameKey('Lynch,  Dominque'));
t('the comma is kept, so "First Last" never unifies with "Last, First"',
  C.nameKey('Ortiz, Brysin') !== C.nameKey('Brysin Ortiz'));
t('empty in, empty out', C.nameKey('') === '' && C.nameKey(null) === '');

const split = C.splitNameAndId('Ortiz, Brysin (80-BORTIZ9517)');
t('name splits off the id', split.name === 'Ortiz, Brysin' && split.id === '80-BORTIZ9517');
t('no parens means no id', C.splitNameAndId('Ortiz, Brysin').id === '');
t('site prefix strips off the id', C.idSuffix('80-BORTIZ9517') === 'BORTIZ9517' && C.idSuffix('80-302660') === '302660');
t('an unprefixed id survives idSuffix', C.idSuffix('302660') === '302660');

console.log('— clocks and shift ranges —');
t('7:30 AM  -> 450', C.parseClock('7:30 AM') === 450);
t('12:00 AM -> 0', C.parseClock('12:00 AM') === 0);
t('12:30 PM -> 750', C.parseClock('12:30 PM') === 750);
t('garbage -> null', C.parseClock('soon') === null && C.parseClock('7:99 AM') === null);

const day = C.parseShiftRange('7:30 AM - 4:00 PM');
t('a day shift keeps its own day', day.start === 450 && day.end === 960 && !day.overnight);
const night = C.parseShiftRange('9:30 PM - 6:00 AM');
t('a night shift rolls its end past midnight', night.start === 1290 && night.end === 1800 && night.overnight);
t('a night shift is 8.5 hours, not -15.5', night.hours === 8.5);
const toMidnight = C.parseShiftRange('3:30 PM - 12:00 AM');
t('midnight is the END of the shift day', toMidnight.end === 1440 && toMidnight.hours === 8.5);
t('a 20-hour shift is flagged suspect', C.parseShiftRange('7:30 AM - 4:00 AM').suspect === true);
t('a normal shift is not suspect', day.suspect === false);
t('a day code is not a range', C.parseShiftRange('PTO') === null);
t('blank is not a range', C.parseShiftRange('') === null);

console.log('— as-of from the export file name —');
const stamp = C.asOfFromFileName('_Report Output_On Premise - Simple_x-chale_2026-08-25T11_12_00.521.csv');
t('the export time is read as local time',
  stamp.getFullYear() === 2026 && stamp.getMonth() === 7 && stamp.getDate() === 25 &&
  stamp.getHours() === 11 && stamp.getMinutes() === 12);
t('a name with no stamp yields null', C.asOfFromFileName('schedule.xlsx') === null);
t('isoDate uses the local calendar day', C.isoDate(new Date(2026, 7, 25, 23, 30)) === '2026-08-25');

/* ---------- the schedule report ----------
   Shaped exactly like the WFM export: a title block, then one section per
   location, with merged day columns landing at uneven indices. */
console.log('— schedule report —');
const scheduleAoa = [
  ['', '', '', '', '', '', '', '', '', 'Employee Schedule - Weekly'],
  ['Time Period :', '', '8/23/2026 - 8/29/2026', '', '', '', '', '', '', '', '', 'Executed on :', '8/25/2026 12:02 PM'],
  ['Query :', '', 'All Home'],
  [''],
  ['GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523'],
  ['Employee', '', '', 'Primary Job', '', 'Sun', '', '', 'Mon', '', 'Tue', '', '', 'Wed', 'Thu', 'Fri', 'Sat'],
  ['', '', '', '', '', '8/23/2026', '', '', '8/24/2026', '', '8/25/2026', '', '', '8/26/2026', '8/27/2026', '8/28/2026', '8/29/2026'],
  ['Day, Dana', '', '', 'Default', '', '', '', '', '7:30 AM - 4:00 PM', '', '7:30 AM - 4:00 PM', '', '', '', '', '', ''],
  ['Night, Nina', '', '', 'Default', '', '', '', '', '9:30 PM - 6:00 AM', '', '', '', '', '', '', '', ''],
  ['Later, Lee', '', '', 'Default', '', '', '', '', '', '', '2:00 PM - 10:30 PM', '', '', '', '', '', ''],
  ['Off, Otis', '', '', 'Default', '', '', '', '', '7:30 AM - 4:00 PM', '', 'PTO', '', '', '', '', '', ''],
  ['GEODIS/US/CL/CLSCEN/CLSL/CL1554/1554'],
  ['Employee', '', '', 'Primary Job', '', 'Sun', '', '', 'Mon', '', 'Tue', '', '', 'Wed', 'Thu', 'Fri', 'Sat'],
  ['', '', '', '', '', '8/23/2026', '', '', '8/24/2026', '', '8/25/2026', '', '', '8/26/2026', '8/27/2026', '8/28/2026', '8/29/2026'],
  ['Second, Sam', '', '', 'Default', '', '', '', '', '7:00 AM - 3:30 PM', '', '7:00 AM - 3:30 PM', '', '', '', '', '', '']
];
const sched = C.parseSchedule(scheduleAoa);
t('the reporting period is read', sched.periodStart === '2026-08-23' && sched.periodEnd === '2026-08-29');
t('the execution time is read', sched.executedAt === '8/25/2026 12:02 PM');
t('all seven days are dated', sched.dates.length === 7 && sched.dates[0] === '2026-08-23');
t('every employee row across both sections is read', sched.people.length === 5);
t('the location header attaches to its section',
  sched.people[0].location.endsWith('1523') && sched.people[4].location.endsWith('1554'));
t('the primary job column is found', sched.people[0].job === 'Default');
t('merged day columns land on the right dates',
  sched.people[0].shifts['2026-08-25'].raw === '7:30 AM - 4:00 PM' && !sched.people[0].shifts['2026-08-23']);
t('a location path row is not read as a person',
  !sched.people.some(p => p.name.indexOf('GEODIS/') === 0));
t('a day code is kept, not dropped',
  sched.people[3].shifts['2026-08-25'].code === 'PTO' && sched.people[3].shifts['2026-08-25'].start === null);

console.log('— on-premise report —');
const presAoa = [
  ['Employee Full Name & ID', 'On Premises', 'Primary location (path)', 'Reports To'],
  ['Day, Dana (80-DDAY0001)', 'true', 'GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523', 'Boss, Bea'],
  ['Night, Nina (80-NNIGH0002)', 'false', 'GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523', 'Boss, Bea'],
  ['Later, Lee (80-LLEE0003)', 'true', 'GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523', 'Boss, Bea'],
  ['Off, Otis (80-OOTIS0004)', 'false', 'GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523', 'Boss, Bea'],
  ['Second, Sam (80-SSAM0005)', 'false', 'GEODIS/US/CL/CLSCEN/CLSL/CL1554/1554', 'Chief, Cal'],
  ['Ghost, Gus (80-GGUS0006)', 'true', 'GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523', 'Boss, Bea']
];
const pres = C.parseOnPremise(presAoa);
t('every presence row is read', pres.people.length === 6);
t('the employee id is split out of the name', pres.people[0].wfmId === '80-DDAY0001');
t('"true"/"false" become booleans', pres.people[0].present === true && pres.people[1].present === false);
t('the supervisor is read', pres.people[0].manager === 'Boss, Bea');
t('a report with no recognisable columns is reported, not silently empty',
  C.parseOnPremise([['a', 'b']]).warnings.length === 1);
t('columns are found by header text, not position', C.parseOnPremise([
  ['Reports To', 'Primary location (path)', 'On Premises', 'Employee Full Name & ID'],
  ['Boss, Bea', 'x', 'true', 'Day, Dana (80-DDAY0001)']
]).people[0].wfmId === '80-DDAY0001');

/* ---------- coverage ----------
   Tuesday 8/25 at 11:12 AM, which is: inside Dana's day shift, after Nina's
   Monday-night shift ended at 6 AM, before Lee's 2 PM shift starts. */
console.log('— coverage at 8/25 11:12 AM —');
const asOf = new Date(2026, 7, 25, 11, 12);
const cov = C.buildCoverage({ schedule: sched, presence: pres, asOf: asOf });
const by = {};
cov.rows.forEach(r => { by[r.name] = r; });

t('on shift and on premise -> working', by['Day, Dana'].status === 'working');
t('scheduled later and on premise -> early', by['Later, Lee'].status === 'early');
t('on shift and NOT on premise -> missing', by['Second, Sam'].status === 'missing');
t('a missing associate is a "bad" exception', by['Second, Sam'].severity === 'bad');
t('on premise with no shift covering now -> unscheduled', by['Ghost, Gus'].status === 'unscheduled');
t('an approved day off is not a no-show', by['Off, Otis'].status === 'off' && by['Off, Otis'].dayCode === 'PTO');
t('a person with no row in the schedule is flagged', by['Ghost, Gus'].inSchedule === false);
t('the employee id rides along for the roster join', by['Day, Dana'].wfmId === '80-DDAY0001');
t('the supervisor rides along so an exception is actionable', by['Second, Sam'].manager === 'Chief, Cal');
t('minutes into shift are counted', by['Day, Dana'].minutesIntoShift === 11 * 60 + 12 - 450);
t('minutes until shift are counted', by['Later, Lee'].minutesUntilShift === 14 * 60 - (11 * 60 + 12));

console.log('— overnight shifts —');
t('a finished overnight shift is complete, not absent', by['Night, Nina'].status === 'complete');
// The case that matters: 5 AM Tuesday, mid-way through Monday night's shift.
const atFive = C.buildCoverage({ schedule: sched, presence: pres, asOf: new Date(2026, 7, 25, 5, 0) });
const nina = atFive.rows.find(r => r.name === 'Night, Nina');
t('at 5 AM the night crew is still on their PREVIOUS day\'s shift', nina.status === 'missing');
t('the shift is credited to the day it started', nina.shiftDate === '2026-08-24');
t('and it is marked as crossing midnight', nina.overnight === true);
// The day crew must not be swept up as absent just because it is 5 AM.
t('a day-crew associate already on site at 5 AM reads as early, not absent',
  atFive.rows.find(r => r.name === 'Day, Dana').status === 'early');
t('a day-crew associate not yet on site at 5 AM reads as scheduled, not absent',
  atFive.rows.find(r => r.name === 'Second, Sam').status === 'scheduled');

console.log('— the grace window —');
// 7:32 AM: two minutes into Dana's shift, with Dana not yet clocked in.
const presLate = { people: pres.people.map(p => ({ ...p, present: false })), warnings: [] };
const inGrace = C.buildCoverage({ schedule: sched, presence: presLate, asOf: new Date(2026, 7, 25, 7, 32), graceMinutes: 10 });
t('inside the grace window -> starting, not an exception',
  inGrace.rows.find(r => r.name === 'Day, Dana').status === 'starting');
const pastGrace = C.buildCoverage({ schedule: sched, presence: presLate, asOf: new Date(2026, 7, 25, 7, 45), graceMinutes: 10 });
t('past the grace window -> missing', pastGrace.rows.find(r => r.name === 'Day, Dana').status === 'missing');
t('grace of 0 makes the shift start the deadline',
  C.buildCoverage({ schedule: sched, presence: presLate, asOf: new Date(2026, 7, 25, 7, 31), graceMinutes: 0 })
    .rows.find(r => r.name === 'Day, Dana').status === 'missing');

console.log('— still on premise after the shift —');
const presLingering = { people: pres.people.map(p => ({ ...p, present: true })), warnings: [] };
const after = C.buildCoverage({ schedule: sched, presence: presLingering, asOf: new Date(2026, 7, 25, 17, 0) });
t('present after the shift ended -> still on site',
  after.rows.find(r => r.name === 'Day, Dana').status === 'lingering');
t('and it is a warning, not an exception',
  after.rows.find(r => r.name === 'Day, Dana').severity === 'warn');

console.log('— summary —');
t('everyone from both files is counted once', cov.summary.total === 6);
t('on-shift counts only the shifts covering now', cov.summary.onShift === 2);
t('coverage is working / on shift', cov.summary.coverage === 50);
t('exceptions count the bad rows', cov.summary.exceptions === 2);
t('people with no schedule row are counted', cov.summary.noSchedule === 1);
t('coverage is null, not NaN, when nobody is on shift',
  C.buildCoverage({ schedule: sched, presence: pres, asOf: new Date(2026, 7, 25, 6, 30) }).summary.coverage === null);
t('at 3 AM the night crew still counts as on shift',
  C.buildCoverage({ schedule: sched, presence: pres, asOf: new Date(2026, 7, 25, 3, 0) }).summary.onShift === 1);
t('exceptions sort to the top', cov.rows[0].severity === 'bad');

console.log('— nobody is dropped —');
t('a scheduled person absent from the on-premise file still appears', (() => {
  const thin = { people: pres.people.filter(p => p.name !== 'Day, Dana'), warnings: [] };
  const r = C.buildCoverage({ schedule: sched, presence: thin, asOf: asOf });
  const d = r.rows.find(x => x.name === 'Day, Dana');
  return r.rows.length === 6 && d && d.inPresence === false && r.summary.noPresence === 1;
})());
t('a duplicate name across two locations is reported, not merged', (() => {
  const dupAoa = scheduleAoa.slice();
  dupAoa.push(['Day, Dana', '', '', 'Default', '', '', '', '', '5:00 AM - 1:30 PM', '', '5:00 AM - 1:30 PM']);
  const s2 = C.parseSchedule(dupAoa);
  return s2.people.length === 6 && s2.warnings.some(w => w.indexOf('more than one location') !== -1);
})());
t('a suspect shift length is reported', sched.warnings.length === 0 && (() => {
  const bad = scheduleAoa.slice();
  bad.push(['Long, Lou', '', '', 'Default', '', '', '', '', '7:30 AM - 4:00 AM']);
  return C.parseSchedule(bad).warnings.some(w => w.indexOf('20.5 hours') !== -1);
})());

console.log('— roster link —');
const profiles = new Map([
  ['80-DDAY0001', { badge: '80-DDAY0001', name: 'Day, Dana', market: 'St. Louis' }],
  ['LLEE0003', { badge: 'LLEE0003', name: 'Later, Lee', market: 'St. Louis' }],
  ['9999', { badge: '9999', name: 'Second, Sam', market: 'St. Louis' }]
]);
const linked = C.linkRoster(cov.rows.map(r => ({ ...r })), profiles, v => String(v || '').trim());
const L = {};
linked.forEach(r => { L[r.name] = r; });
t('a full employee id reaches the roster', L['Day, Dana'].badge === '80-DDAY0001' && L['Day, Dana'].rosterMatch === 'id');
t('a prefix-stripped id reaches the roster', L['Later, Lee'].badge === 'LLEE0003' && L['Later, Lee'].rosterMatch === 'id');
t('name is the last resort, and says so', L['Second, Sam'].badge === '9999' && L['Second, Sam'].rosterMatch === 'name');
t('the market comes along', L['Day, Dana'].market === 'St. Louis');
t('no match leaves the row unlinked rather than guessing', L['Ghost, Gus'].badge === '');
t('a duplicated roster name is never matched by name', (() => {
  const twins = new Map([
    ['a1', { badge: 'a1', name: 'Second, Sam', market: 'X' }],
    ['a2', { badge: 'a2', name: 'Second, Sam', market: 'Y' }]
  ]);
  const out = C.linkRoster([{ ...L['Second, Sam'], badge: '', rosterMatch: '' }], twins, v => String(v || '').trim());
  return out[0].badge === '';
})());
t('an empty roster is a no-op, not a crash', C.linkRoster([{ wfmId: 'x', nameKey: 'y' }], new Map()).length === 1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
