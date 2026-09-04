/* Payroll: the discrepancy pipeline and intake, and watching Beeline hours for
   changes that land after a period closes. */
const P = require('../payroll-core.js');
const SC = require('../schedule-core.js');
const FI = require('../form-intake.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

console.log('— the discrepancy pipeline —');
t('seven statuses', P.pipeline.STATUS_KEYS.length === 7);
t('starts at Received', P.pipeline.DEFAULT_STATUS === 'Received');
t('Corrected is the resolved state', P.pipeline.isResolved('Corrected'));
t('handed to payroll is NOT resolved yet', !P.pipeline.isResolved('Submitted to Payroll'));
t('and still needs action', P.pipeline.needsAction('Submitted to Payroll'));
/* A correction that has been sent but not yet checked against Beeline. It
   feels finished, which is exactly why it must keep counting as open work --
   an hour that never reached Beeline correctly cannot be invoiced. */
t('Pending Billing sits between the hand-off and the fix',
  P.pipeline.STATUS_KEYS.indexOf('Pending Billing') === P.pipeline.STATUS_KEYS.indexOf('Submitted to Payroll') + 1 &&
  P.pipeline.STATUS_KEYS.indexOf('Pending Billing') < P.pipeline.STATUS_KEYS.indexOf('Corrected'));
t('it is not treated as resolved', !P.pipeline.isResolved('Pending Billing'));
t('and still needs action', P.pipeline.needsAction('Pending Billing'));
t('it reads as its own thing, not as Corrected',
  P.pipeline.statusMeta('Pending Billing').label === 'Pending billing');
t('Researching needs action', P.pipeline.needsAction('Researching'));
t('Corrected does not', !P.pipeline.needsAction('Corrected'));
t('No adjustment needed is finished', !P.pipeline.needsAction('No Adjustment Needed'));
t('but is not "resolved"', !P.pipeline.isResolved('No Adjustment Needed'));
t('legacy Open maps to Received', P.pipeline.normalizeStatus('Open') === 'Received');
t('unknown status kept as-is', P.pipeline.statusMeta('Escalated').unknown === true);

console.log('— the date picker on the form —');
t('M/D/YYYY', P.parseDate('8/25/2026') === '2026-08-25');
t('ISO date', P.parseDate('2026-08-25') === '2026-08-25');
t('ISO timestamp', P.parseDate('2026-08-25T00:00:00Z') === '2026-08-25');
t('two-digit year', P.parseDate('8/25/26') === '2026-08-25');
t('junk gives nothing, not a guess', P.parseDate('sometime') === '');
t('blank gives nothing', P.parseDate('') === '');
t('impossible date rejected', P.parseDate('2/30/2026') === '');

console.log('— week ending —');
t('a Tuesday rolls to that Sunday', P.weekEndingOf('2026-08-25') === '2026-08-30');
t('a Sunday is already the week end', P.weekEndingOf('2026-08-30') === '2026-08-30');
t('a Saturday rolls one day', P.weekEndingOf('2026-08-29') === '2026-08-30');
t('junk is empty', P.weekEndingOf('nope') === '');

console.log('— a form submission becomes a discrepancy —');
const profiles = [
  { badge: '215001', name: 'Luz Grachen', market: 'Chicago' },
  { badge: '215003', name: 'Twin Person' },
  { badge: '215004', name: 'Twin Person' }
];
const byName = FI.buildNameIndex(profiles, SC.rosterKey);
const opts = { byName, rosterKey: SC.rosterKey, now: new Date(2026, 7, 25) };
let out = P.toDiscrepancy({
  name: 'Luz Grachen', location: 'LEGO', date: '8/25/2026',
  details: 'Missing 4 hours on Tuesday', responseId: '900'
}, opts);
t('resolved to a badge', out.record.badge === '215001');
t('reported as matched', out.matched === true);
t('name kept', out.record.name === 'Luz Grachen');
t('location kept', out.record.location === 'LEGO');
t('date normalised', out.record.date === '2026-08-25');
t('week ending derived', out.record.weekEnding === '2026-08-30');
t('details kept', out.record.details === 'Missing 4 hours on Tuesday');
t('starts at Received', out.record.status === 'Received');
t('source recorded', out.record.source === 'Payroll discrepancy form');
t('id from the response id', out.record.id === 'PDF-900');
t('no warnings on a clean one', out.warnings.length === 0);
t('reversed name order resolves', P.toDiscrepancy({ name: 'Grachen, Luz', date: '8/25/2026' }, opts).record.badge === '215001');

out = P.toDiscrepancy({ name: 'Nobody Here', date: '8/25/2026', details: 'x' }, opts);
t('an unknown name still produces a record', !!out.record.id);
t('with no badge', out.record.badge === '');
t('and is reported', out.warnings.some(w => w.indexOf('not on the current assignment roster') !== -1));
out = P.toDiscrepancy({ name: 'Twin Person', date: '8/25/2026' }, opts);
t('a duplicated name is not guessed at', out.record.badge === '' && out.ambiguous === true);
out = P.toDiscrepancy({ name: 'Luz Grachen', date: 'whenever' }, opts);
t('an unreadable date leaves the field empty', out.record.date === '');
t('rather than inventing one', out.record.weekEnding === '');
t('and says so', out.warnings.some(w => w.indexOf('could not be read') !== -1));
const a = P.toDiscrepancy({ name: 'A', date: '8/25/2026', details: 'x' }, opts);
const b = P.toDiscrepancy({ name: 'A', date: '8/25/2026', details: 'x' }, opts);
t('the same submission gives the same id', a.record.id === b.record.id);
t('a different one differs',
  P.toDiscrepancy({ name: 'A', date: '8/25/2026', details: 'y' }, opts).record.id !== a.record.id);

console.log('— hours: the first pull is a baseline —');
const p1 = { weekEnding: '2026-08-30', takenAt: '2026-08-31T09:00:00Z',
  rows: [{ badge: '1', name: 'A', hours: 40 }, { badge: '2', name: 'B', hours: 38 }] };
let diff = P.compareHours(null, p1, {});
t('flagged as a baseline', diff.baseline === true);
t('nobody reads as newly added', diff.changes.length === 0);
t('but the totals are there', diff.summary.totalHours === 78 && diff.summary.people === 2);

console.log('— hours: what moved —');
const p2 = { weekEnding: '2026-08-30', takenAt: '2026-09-02T15:00:00Z',
  rows: [{ badge: '1', name: 'A', hours: 44 }, { badge: '3', name: 'C', hours: 8 }] };
diff = P.compareHours(p1, p2, {});
t('not a baseline now', diff.baseline === false);
t('three changes', diff.changes.length === 3);
const byKind = k => diff.changes.filter(c => c.kind === k);
t('one changed', byKind('changed').length === 1);
t('one added', byKind('added').length === 1);
t('one removed', byKind('removed').length === 1);
t('the change records before and after', byKind('changed')[0].from === 40 && byKind('changed')[0].to === 44);
t('and the delta', byKind('changed')[0].delta === 4);
t('a removal is a negative delta', byKind('removed')[0].delta === -38);
t('sorted by size of movement', Math.abs(diff.changes[0].delta) >= Math.abs(diff.changes[1].delta));
t('net movement summed', diff.summary.net === -26);
t('identical hours produce no change', P.compareHours(p1, p1, {}).changes.length === 0);
t('a rounding-level difference is not a change',
  P.compareHours({ rows: [{ badge: '1', hours: 40.001 }] }, { rows: [{ badge: '1', hours: 40.002 }] }, {}).changes.length === 0);

console.log('— the point: changes after the period closed —');
diff = P.compareHours(p1, p2, { closesAt: '2026-09-01T17:00:00Z' });
t('the pull was after close', diff.afterClose === true);
t('every change from it is flagged', diff.changes.every(c => c.afterClose === true));
diff = P.compareHours(p1, { ...p2, takenAt: '2026-08-31T23:00:00Z' }, { closesAt: '2026-09-01T17:00:00Z' });
t('a pull before close is not flagged', diff.afterClose === false);
t('nor are its changes', diff.changes.every(c => c.afterClose === false));
diff = P.compareHours(p1, p2, {});
t('no close date means no flag, not a guessed cutoff', diff.afterClose === false);
diff = P.compareHours(p1, p2, { closesAt: 'not a date' });
t('an unparseable close date also refuses to flag', diff.afterClose === false);

console.log('— edges —');
t('rows without a badge are skipped', P.normalizeHours([{ name: 'no badge', hours: 8 }]).size === 0);
t('non-numeric hours become 0', P.normalizeHours([{ badge: '1', hours: 'x' }]).get('1').hours === 0);
t('empty snapshots are safe', P.compareHours({ rows: [] }, { rows: [] }, {}).changes.length === 0);
t('a missing next snapshot is safe', P.compareHours(p1, null, {}).changes.length === 2);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
