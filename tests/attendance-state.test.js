/* One attendance state per person per day, however many times the on-premise
   report was pulled -- plus the "Present" override for a punch-out mistaken for
   an absence. */
const SC = require('../schedule-core.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const KEY = 'b:B1';
const keys = ['b:B1', 'n:ava reed'];
const check = (asOf, present, status) => ({
  id: 'CK' + asOf, asOf: '2026-08-25T' + asOf + ':00',
  presentKeys: present ? [KEY] : [],
  exceptions: status ? [{ key: KEY, name: 'Reed, Ava', badge: 'B1', status: status, shift: '7:00 AM - 3:30 PM' }] : []
});
const day = (checks, documented) => ({ date: '2026-08-25', checks: checks, documented: documented || {} });

console.log('— the reported bug: repeated uploads —');
let a = SC.resolveAttendance(day([check('10:00', false, 'missing'), check('10:15', false, 'missing'), check('10:30', false, 'missing')]), keys);
t('three pulls collapse to ONE state', a.status === 'missing');
t('and it reads absent', a.present === false);
t('the pulls are kept as detail', a.evidence.length === 3);
t('the state names how many covered them', a.checks === 3);

console.log('— presence wins —');
a = SC.resolveAttendance(day([check('10:00', false, 'missing'), check('10:30', true, null)]), keys);
t('absent then present -> present', a.present === true);
t('labelled on premise', a.label === 'On premise');
t('records when they first appeared', a.firstPresent === '2026-08-25T10:30:00');
t('severity is ok', a.severity === 'ok');
a = SC.resolveAttendance(day([check('10:00', true, null), check('10:30', false, 'missing')]), keys);
t('present then absent is still present (they were here)', a.present === true);

console.log('— absent at every pull stays absent —');
a = SC.resolveAttendance(day([check('08:00', false, 'missing'), check('14:00', false, 'missing')]), keys);
t('still absent', a.present === false);
t('carries the status', a.status === 'missing');
t('with a readable label', a.label === 'Not clocked in');
t('flagged as an exception', a.severity === 'bad');

console.log('— a pull that says nothing about them is not evidence —');
// A 1st-shift associate is neither on premise nor an exception at an evening pull.
a = SC.resolveAttendance(day([check('10:00', true, null), { id: 'CK3', asOf: '2026-08-25T18:00:00', presentKeys: [], exceptions: [] }]), keys);
t('the evening pull is skipped', a.evidence.length === 1);
t('so it cannot mark a 1st-shift person absent', a.present === true);
a = SC.resolveAttendance(day([{ id: 'x', asOf: '2026-08-25T18:00:00', presentKeys: [], exceptions: [] }]), keys);
t('no relevant pulls at all -> no state', a.checks === 0 && a.status === '');
t('and no invented label', a.label === '');

console.log('— the Present override (punched out instead of in) —');
const doc = {}; doc[KEY] = { disposition: 'Present', reason: 'punched out by mistake' };
a = SC.resolveAttendance(day([check('10:00', false, 'missing'), check('10:30', false, 'missing')], doc), keys);
t('reader says absent, documentation says present', a.present === true);
t('flagged as an override, not a sighting', a.overridden === true);
t('labelled so nobody thinks the reader saw them', a.label === 'Present (documented)');
t('severity drops to ok', a.severity === 'ok');
t('the underlying pulls are still there', a.evidence.length === 2);
t('the constant is shared, not duplicated', SC.PRESENT_DISPOSITION === 'Present');
const other = {}; other[KEY] = { disposition: 'Called in', reason: 'sick' };
a = SC.resolveAttendance(day([check('10:00', false, 'missing')], other), keys);
t('a different disposition does not mark them present', a.present === false);
t('not treated as an override', a.overridden === false);

console.log('— found by either key —');
a = SC.resolveAttendance(day([{ id: 'x', asOf: '2026-08-25T10:00:00', presentKeys: ['n:ava reed'], exceptions: [] }]), keys);
t('name key works when the badge never resolved', a.present === true);
t('an unrelated person is unaffected', SC.resolveAttendance(day([check('10:00', true, null)]), ['b:OTHER']).checks === 0);

console.log('— edges —');
t('no day document', SC.resolveAttendance(null, keys).checks === 0);
t('empty day', SC.resolveAttendance(day([]), keys).checks === 0);
t('no keys', SC.resolveAttendance(day([check('10:00', true, null)]), []).checks === 0);

console.log('— Present carries into the headcount export —');
const schedule = SC.parseSchedule([
  ['Time Period :', '', '8/23/2026 - 8/29/2026'],
  ['GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523'],
  ['Employee', 'Primary Job', 'Tue'], ['', '', '8/25/2026'],
  ['Reed, Ava', 'Job', '7:00 AM - 3:30 PM'], ['Nash, Cleo', 'Job', '7:00 AM - 3:30 PM']
]);
const presence = SC.parseOnPremise([
  ['Employee Full Name & ID', 'On Premises', 'Primary location (path)', 'Reports To'],
  ['Reed, Ava (80-A1)', 'false', 'GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523', 'B, B'],
  ['Nash, Cleo (80-C1)', 'false', 'GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523', 'B, B']
]);
const profiles = new Map([
  ['b1', { badge: 'b1', name: 'Ava Reed', crmStart: '1/2/2026', points: 0 }],
  ['b2', { badge: 'b2', name: 'Cleo Nash', crmStart: '1/3/2026', points: 0 }]
]);
const res = SC.buildCoverage({ schedule, presence, asOf: new Date(2026, 7, 25, 9, 0) });
SC.linkRoster(res.rows, profiles, v => String(v || '').trim());
const bare = SC.spreadsheetExport(res, { location: '1523', shift: '1st', profiles, documented: {} });
t('both read absent to the reader', bare.summary.onsite === 0 && bare.summary.short === 2);

const marked = {};
marked[SC.personKey({ badge: 'b1' })] = { disposition: 'Present', reason: 'punched out by mistake' };
const fixed = SC.spreadsheetExport(res, { location: '1523', shift: '1st', profiles, documented: marked });
t('Onsite counts the corrected person', fixed.summary.onsite === 1);
t('Short drops to match', fixed.summary.short === 1);
t('Expected is unchanged', fixed.summary.expected === 2);
const avaRow = fixed.rows.find(r => r.name === 'Reed, Ava');
t('the row reads present', avaRow.present === true);
t('Comments say Present, not "Not clocked in"', avaRow.comments.indexOf('Present') === 0);
t('and keeps the reason', avaRow.comments.indexOf('punched out by mistake') !== -1);
t('the genuinely absent person is untouched',
  fixed.rows.find(r => r.name === 'Nash, Cleo').comments === 'Not clocked in');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
