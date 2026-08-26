/* The time-off pipeline: the status vocabulary, what excuses an absence, and the
   change log that will carry a real identity once sign-in exists. */
const fs = require('fs');
const path = require('path');
const TO = require('../timeoff-core.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };
const NOW = new Date('2026-08-25T14:00:00Z');
const actor = TO.actorOf('Cody Hale', 'local_123');

console.log('— the pipeline —');
t('seven statuses', TO.STATUS_KEYS.length === 7);
t('starts at Received', TO.DEFAULT_STATUS === 'Received');
t('ordered from received to done', TO.STATUS_KEYS[0] === 'Received' && TO.STATUS_KEYS[2] === 'Approved');
t('includes the client-approval step', TO.STATUS_KEYS.indexOf('Sent for Client Approval') === 1);
t('includes payroll', TO.STATUS_KEYS.indexOf('Submitted to Payroll') === 3);

console.log('— which statuses excuse an absence —');
t('Approved excuses', TO.isExcused('Approved'));
t('Submitted to Payroll excuses', TO.isExcused('Submitted to Payroll'));
t('Completed excuses', TO.isExcused('Completed'));
t('Received does NOT excuse', !TO.isExcused('Received'));
t('being SENT for approval is not approval', !TO.isExcused('Sent for Client Approval'));
t('Denied does not excuse', !TO.isExcused('Denied'));
t('Cancelled does not excuse', !TO.isExcused('Cancelled'));

console.log('— "needs action" is not "not approved" —');
t('Received needs action', TO.needsAction('Received'));
t('Sent for client approval needs action', TO.needsAction('Sent for Client Approval'));
t('Approved does not', !TO.needsAction('Approved'));
t('Denied is finished, not pending', !TO.needsAction('Denied'));
t('Cancelled is finished too', !TO.needsAction('Cancelled'));

console.log('— older data still reads —');
t('legacy Pending maps to Received', TO.normalizeStatus('Pending') === 'Received');
t('lowercase pending too', TO.normalizeStatus('pending') === 'Received');
t('blank defaults', TO.normalizeStatus('') === 'Received');
t('case-insensitive match', TO.normalizeStatus('approved') === 'Approved');
t('a legacy Approved still excuses', TO.isExcused('Pending') === false && TO.isExcused('Approved') === true);
t('an unknown status is kept, not coerced', TO.normalizeStatus('Escalated') === 'Escalated');
t('and flagged as unknown', TO.statusMeta('Escalated').unknown === true);
t('an unknown status never excuses', !TO.isExcused('Escalated'));
t('known statuses are known', TO.isKnown('Approved') && !TO.isKnown('Escalated'));

console.log('— an actor, until sign-in exists —');
t('name kept', actor.name === 'Cody Hale');
t('id kept for later', actor.id === 'local_123');
t('source says where it came from', actor.source === 'local');
t('a blank name is not silently attributed', TO.actorOf('').name === 'Unknown');
t('long names capped', TO.actorOf('x'.repeat(200)).name.length === 80);

console.log('— a status change is logged —');
const rec = { id: 'FORM-1-0', status: 'Received', source: 'Form (English)', submittedAt: '2026-08-24T09:00:00Z' };
let patch = TO.applyStatus(rec, 'Approved', actor, NOW);
t('the new status is set', patch.status === 'Approved');
t('the record is identified', patch.id === 'FORM-1-0');
t('when it changed', patch.statusUpdatedAt === '2026-08-25T14:00:00.000Z');
t('who changed it', patch.statusUpdatedBy === 'Cody Hale');
t('the log seeds where it started', patch.statusHistory[0].status === 'Received');
t('seeded from when it arrived', patch.statusHistory[0].at === '2026-08-24T09:00:00Z');
t('and marked as an import, not a person', patch.statusHistory[0].source === 'import');
t('then records the change', patch.statusHistory[1].status === 'Approved');
t('with the actor id for later', patch.statusHistory[1].byId === 'local_123');
t('two entries so far', patch.statusHistory.length === 2);

const moved = Object.assign({}, rec, patch);
patch = TO.applyStatus(moved, 'Submitted to Payroll', TO.actorOf('Someone Else', 'local_9'), NOW);
t('the trail accumulates', patch.statusHistory.length === 3);
t('and keeps the earlier actor', patch.statusHistory[1].by === 'Cody Hale');
t('alongside the new one', patch.statusHistory[2].by === 'Someone Else');
t('applyStatus does not mutate the record', moved.statusHistory.length === 2);

console.log('— the log cannot grow without bound —');
let long = { id: 'x', status: 'Received', statusHistory: [] };
for (let i = 0; i < 60; i++) long = Object.assign(long, TO.applyStatus(long, i % 2 ? 'Approved' : 'Received', actor, NOW));
t('capped', long.statusHistory.length === TO.MAX_LOG);
t('the most recent survive', long.statusHistory[long.statusHistory.length - 1].status === TO.normalizeStatus(long.status));

console.log('— connecting an unmatched request —');
const orphan = { id: 'FORM-2-0', name: 'Luiz Grachen', badge: '', status: 'Received' };
const conn = TO.applyConnection(orphan, '215001', actor, NOW);
t('the badge is set', conn.badge === '215001');
t('who linked it', conn.connectedBy === 'Cody Hale');
t('and when', conn.connectedAt === '2026-08-25T14:00:00.000Z');
t('the link is in the same trail', conn.statusHistory[0].note === 'Linked to badge 215001');
t('the status is unchanged by linking', conn.status === undefined);
t('does not mutate', orphan.badge === '');

console.log('— shared modules stay in sync —');
['reconcile-core.js', 'schedule-core.js', 'form-intake.js', 'timeoff-core.js'].forEach(f => {
  const a = path.join(__dirname, '..', f), b = path.join(__dirname, '..', 'functions', f);
  t(f + ' present in functions/', fs.existsSync(b));
  if (fs.existsSync(b)) t(f + ' byte-identical', fs.readFileSync(a, 'utf8') === fs.readFileSync(b, 'utf8'));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
