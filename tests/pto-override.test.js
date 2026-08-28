/* Approved time off answering for the day it covers.

   Two consequences, and they are the same rule seen from two places. On the
   floor, somebody with approved PTO is on PTO, not missing -- so no exception,
   no documentation box, and nothing to log against them. On the ledger, an
   occurrence that was already logged for such a day stops carrying points.

   What counts as permission is the pipeline's `resolved` state. A request still
   at "Received" is a request, not permission; letting it excuse an absence
   would mean anybody could clear an infraction by filing paperwork afterwards. */
const SC = require('../schedule-core.js');
const TO = require('../timeoff-core.js');
const { SuiteData: SD } = require('../suite-data.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const DAY = '2026-08-27';
const req = (badge, status, start, end, type) =>
  ({ id: 'T' + badge + start, badge, status, start, end: end || '', type: type || 'PTO' });

console.log('— which requests are permission —');
const ix = TO.excusedIndex([
  req('b1', 'Approved', DAY),
  req('b2', 'Received', DAY),
  req('b3', 'Sent for Client Approval', DAY),
  req('b4', 'Denied', DAY),
  req('b5', 'Cancelled', DAY),
  req('b6', 'Submitted to Payroll', DAY),
  req('b7', 'Completed', DAY)
]);
t('Approved is', !!TO.excusedOn(ix, 'b1', DAY));
t('Submitted to payroll is -- it was approved to get there', !!TO.excusedOn(ix, 'b6', DAY));
t('Completed is', !!TO.excusedOn(ix, 'b7', DAY));
t('Received is not', !TO.excusedOn(ix, 'b2', DAY));
t('awaiting the client is not', !TO.excusedOn(ix, 'b3', DAY));
t('Denied is not', !TO.excusedOn(ix, 'b4', DAY));
t('Cancelled is not', !TO.excusedOn(ix, 'b5', DAY));

console.log('— which days a request covers —');
const span = req('b1', 'Approved', '2026-08-26', '2026-08-28');
t('the first day', TO.coversDate(span, '2026-08-26'));
t('the middle', TO.coversDate(span, '2026-08-27'));
t('the last day', TO.coversDate(span, '2026-08-28'));
t('not the day before', !TO.coversDate(span, '2026-08-25'));
t('not the day after', !TO.coversDate(span, '2026-08-29'));
t('no end means the start day alone',
  TO.coversDate(req('b', 'Approved', DAY), DAY) && !TO.coversDate(req('b', 'Approved', DAY), '2026-08-28'));
t('a backwards range is read the right way round',
  TO.coversDate({ start: '2026-08-28', end: '2026-08-26' }, '2026-08-27'));
t('no start covers nothing at all -- it must not excuse every day there is',
  !TO.coversDate({ end: DAY }, DAY));
t('a timestamp is read as its day', TO.coversDate(req('b', 'Approved', DAY + 'T09:00:00Z'), DAY));

console.log('— on the floor —');
const shifts = { '2026-08-27': { raw: '7a-3p', start: 420, end: 900, overnight: false } };
const schedule = { people: [
  { name: 'Away, Ada', nameKey: 'away,ada', shifts },
  { name: 'Here, Hank', nameKey: 'here,hank', shifts },
  { name: 'Gone, Gus', nameKey: 'gone,gus', shifts },
  { name: 'Anyway, Ann', nameKey: 'anyway,ann', shifts }
] };
const presence = SC.parseOnPremise([
  ['Employee Full Name & ID', 'On Premises', 'Primary location (path)', 'Reports To'],
  ['Away, Ada (80-A1)', 'false', 'GEODIS/US/CL/CL1523/1523', 'B, B'],
  ['Here, Hank (80-H1)', 'true', 'GEODIS/US/CL/CL1523/1523', 'B, B'],
  ['Gone, Gus (80-G1)', 'false', 'GEODIS/US/CL/CL1523/1523', 'B, B'],
  ['Anyway, Ann (80-N1)', 'true', 'GEODIS/US/CL/CL1523/1523', 'B, B']
]);
const badges = { 'Away, Ada': 'b1', 'Here, Hank': 'b2', 'Gone, Gus': 'b3', 'Anyway, Ann': 'b4' };
function build() {
  const res = SC.buildCoverage({ schedule, presence, asOf: new Date(2026, 7, 27, 9, 0) });
  res.rows.forEach(r => { r.badge = badges[r.name] || ''; });
  return res;
}
const before = build();
t('without time off, both absentees are exceptions', before.summary.byStatus.missing === 2);
t('and coverage counts them', before.summary.coverage === 50);

const after = SC.applyTimeOff(build(), TO.excusedIndex([
  req('b1', 'Approved', DAY),          // absent, approved  -> on PTO
  req('b3', 'Received', DAY),          // absent, not approved -> still missing
  req('b4', 'Approved', DAY)           // approved but turned up anyway
]), DAY, TO.excusedOn);
const row = n => after.rows.filter(r => r.name === n)[0];
t('the approved absentee reads as on PTO', row('Away, Ada').status === 'pto');
t('which is not an exception', row('Away, Ada').severity === 'ok');
t('the unapproved one is still missing', row('Gone, Gus').status === 'missing');
t('and still an exception', row('Gone, Gus').severity === 'bad');
t('somebody at work is untouched', row('Here, Hank').status === 'working');

console.log('— on the clock despite approved time off —');
t('is left as working, because they are', row('Anyway, Ann').status === 'working');
t('but the request is carried so it can be flagged', !!row('Anyway, Ann').ptoRequest);
t('and it is not counted as PTO cover', after.summary.onPto === 1);

console.log('— what that does to the numbers —');
t('the PTO absence leaves the on-shift count', after.summary.onShift === 3);
t('so coverage is not punished for an authorised absence', after.summary.coverage === 67);
t('exceptions drop to the one that is really unexplained', after.summary.exceptions === 1);
t('and the floor being short is still visible', after.summary.onPto === 1);
t('the summary agrees with the rows it came from',
  after.summary.byStatus.pto === after.rows.filter(r => r.status === 'pto').length);
t('nobody is lost or duplicated', after.rows.length === before.rows.length);

console.log('— a row with no profile cannot be matched, and is not guessed at —');
const noBadge = build();
noBadge.rows.forEach(r => { r.badge = ''; });
SC.applyTimeOff(noBadge, TO.excusedIndex([req('b1', 'Approved', DAY)]), DAY, TO.excusedOn);
t('it stays an exception rather than being excused on a hunch',
  noBadge.rows.filter(r => r.name === 'Away, Ada')[0].status === 'missing');

console.log('— on the ledger —');
const records = [{ badge: 'b1', person: 'Ada Away', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '1/2/2026' }];
const stores = {
  attendance: [
    { id: 'A1', badge: 'b1', date: DAY, type: 'Absent', points: 1, notes: 'no show' },
    { id: 'A2', badge: 'b1', date: '2026-08-20', type: 'Absent', points: 1, notes: 'no show' }
  ],
  timeOff: [req('b1', 'Approved', DAY)],
  ptoCover: (requests, iso) => (requests || []).filter(r => TO.isExcused(r.status) && TO.coversDate(r, iso))[0] || null
};
const profiles = SD.buildProfiles(records, stores);
const ada = profiles.get('b1');
const onDay = ada.attendance.filter(a => a.date === DAY)[0];
const other = ada.attendance.filter(a => a.date === '2026-08-20')[0];
t('the occurrence on the approved day is cleared', onDay.points === 0);
t('but kept on the ledger -- it happened, and somebody logged it', !!onDay);
t('with what cleared it recorded', onDay.excusedBy && onDay.excusedBy.type === 'PTO');
t('and what it used to cost', onDay.originalPoints === 1);
t('an occurrence on any other day is untouched', other.points === 1);
t('so the total counts only the unexcused one', ada.points === 1);
t('and the count of cleared ones is available', ada.excusedByPto === 1);

console.log('— without the injected test, nothing changes —');
const plain = SD.buildProfiles(records, { attendance: stores.attendance, timeOff: stores.timeOff });
t('points stay as recorded', plain.get('b1').points === 2);

console.log('— a request that is not permission clears nothing —');
const pending = SD.buildProfiles(records, {
  attendance: stores.attendance, timeOff: [req('b1', 'Received', DAY)], ptoCover: stores.ptoCover
});
t('a merely-submitted request does not zero an infraction', pending.get('b1').points === 2);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
