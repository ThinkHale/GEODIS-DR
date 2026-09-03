/* Standing tasks: the queue, and the clock that escalates it.

   The rules under test are the ones that were asked for. A task persists until
   somebody marks it complete. Anything untouched for 48 hours becomes urgent.
   Payroll gets 4 hours instead, because money already out the door does not
   wait two days. */
const T = require('../tasks-core.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const NOW = new Date('2026-08-27T12:00:00Z');
const ago = h => new Date(NOW.getTime() - h * 3600000).toISOString();
const task = (kind, hoursOld, status) => T.normalize({
  id: 'x' + kind + hoursOld, kind, title: 'do a thing',
  status: status || 'Open', createdAt: ago(hoursOld), updatedAt: ago(hoursOld)
});

console.log('— the escalation windows —');
t('a fresh task is calm', T.urgencyOf(task('note', 1), NOW) === T.OK);
t('47 hours is not yet urgent', T.urgencyOf(task('note', 47), NOW) !== T.URGENT);
t('48 hours is', T.urgencyOf(task('note', 48), NOW) === T.URGENT);
t('and so is anything past it', T.urgencyOf(task('note', 200), NOW) === T.URGENT);
t('payroll gets four hours, not forty-eight', T.limitFor(task('payroll', 0)) === 4);
t('3 hours of a payroll issue is not urgent', T.urgencyOf(task('payroll', 3), NOW) !== T.URGENT);
t('4 hours is', T.urgencyOf(task('payroll', 4), NOW) === T.URGENT);
t('a payroll issue at 5 hours is urgent while a note at 5 is not',
  T.urgencyOf(task('payroll', 5), NOW) === T.URGENT &&
  T.urgencyOf(task('note', 5), NOW) !== T.URGENT);
t('the last quarter of the window reads as due', T.urgencyOf(task('note', 40), NOW) === T.DUE);
t('payroll warns at three hours', T.urgencyOf(task('payroll', 3.1), NOW) === T.DUE);

console.log('— finished work does not age —');
t('a complete task is never urgent', T.urgencyOf(task('payroll', 500, 'Complete'), NOW) === T.NONE);
t('nor a cancelled one', T.urgencyOf(task('note', 500, 'Cancelled'), NOW) === T.NONE);
t('but a blocked one still does -- blocked is not done',
  T.urgencyOf(task('note', 500, 'Blocked'), NOW) === T.URGENT);
t('complete is not open', !T.isOpen(task('note', 1, 'Complete')));
t('blocked is', T.isOpen(task('note', 1, 'Blocked')));

console.log('— the clock runs from the last update, not from creation —');
const worked = T.normalize({ id: 'w', kind: 'payroll', title: 'x', status: 'In Progress',
  createdAt: ago(72), updatedAt: ago(1) });
t('a task somebody touched an hour ago is calm, however old it is',
  T.urgencyOf(worked, NOW) === T.OK);
const ignored = T.normalize({ id: 'i', kind: 'payroll', title: 'x', status: 'In Progress',
  createdAt: ago(72), updatedAt: ago(9) });
t('one nobody has touched for nine hours is urgent', T.urgencyOf(ignored, NOW) === T.URGENT);
t('a task with no timestamps at all is not called urgent on a guess',
  T.urgencyOf(T.normalize({ id: 'n', kind: 'note', title: 'x', status: 'Open' }), NOW) === T.OK);

console.log('— what a person reads —');
t('time left is shown while there is some', T.ageLabel(task('payroll', 1), NOW) === '3h left');
t('and how far over once there is not', T.ageLabel(task('payroll', 6), NOW) === '2h over');
t('long waits read in days', T.ageLabel(task('note', 96), NOW) === '2d over');
t('a finished task has no age to report', T.ageLabel(task('note', 96, 'Complete'), NOW) === '');

console.log('— kinds —');
t('an unknown kind still ages, on the default window',
  T.limitFor(T.normalize({ id: 'u', kind: 'sideways', title: 'x' })) === 48);
t('and is flagged as unknown rather than relabelled',
  T.kindMeta('sideways').unknown === true && T.kindMeta('sideways').key === 'sideways');
t('a known kind is not flagged', !T.kindMeta('payroll').unknown);
t('every kind names the panel that owns it',
  T.KINDS.every(k => typeof k.panel === 'string' && k.panel.length > 0));

console.log('— raising one —');
const actor = { id: 'a@b.com', name: 'Ada', source: 'account' };
const made = T.create({ kind: 'terminate', title: 'End the assignment for X' }, actor, NOW);
t('it starts open', made.status === 'Open');
t('with an id', !!made.id);
t('stamped with who raised it', made.createdBy === 'Ada');
t('and when', made.createdAt === NOW.toISOString());
t('the log starts at Open, so the first change is not the first entry',
  made.statusHistory.length === 1 && made.statusHistory[0].status === 'Open');
t('the log records the actor id, ready for real sign-in',
  made.statusHistory[0].byId === 'a@b.com');

console.log('— tasks raised from something else are not raised twice —');
const id1 = T.idFor('coverage', 'b:12345:2026-08-27');
t('the id is derived from the source, so it repeats', id1 === T.idFor('coverage', 'b:12345:2026-08-27'));
t('a different day is a different task', id1 !== T.idFor('coverage', 'b:12345:2026-08-28'));
t('and it is found among existing tasks', !!T.existing([{ id: id1 }], 'coverage', 'b:12345:2026-08-27'));
t('an id is safe to put in an URL', /^[A-Za-z0-9:_-]+$/.test(T.idFor('coverage', 'w:80-X (weird)/name')));

console.log('— derived tasks —');
const timeOff = [
  { id: 'TO1', badge: 'b1', name: 'Ann', status: 'Received', type: 'PTO', start: '2026-09-01',
    end: '2026-09-03', submittedAt: ago(60) },
  { id: 'TO2', badge: 'b2', name: 'Ben', status: 'Approved', type: 'PTO', start: '2026-09-01' }
];
const needsAction = s => s !== 'Approved';
const derived = T.fromRecords(timeOff, {
  kind: 'pto', sourceKind: 'timeoff', source: 'Time Off', needsAction,
  titleOf: r => r.type + ' · ' + r.name
});
t('only the request still waiting becomes a task', derived.length === 1);
t('the approved one does not -- that is history, not work', derived[0].name === 'Ann');
t('it is marked derived, so the page knows not to offer a status control', derived[0].derived === true);
t('it remembers what it came from', derived[0].sourceKind === 'timeoff' && derived[0].sourceId === 'TO1');
t('and ages from when it was submitted', T.urgencyOf(derived[0], NOW) === T.URGENT);
t('a derived payroll task uses the four-hour window', T.fromRecords(
  [{ id: 'D1', name: 'Cal', status: 'Received', submittedAt: ago(5) }],
  { kind: 'payroll', sourceKind: 'discrepancies', source: 'Payroll', needsAction: () => true,
    hours: 4, titleOf: r => r.name })
  .map(x => T.urgencyOf(x, NOW))[0] === T.URGENT);

console.log('— handing one to somebody, and overriding where it got to —');
const manager = { id: 'boss@geodis.com', name: 'Mo', source: 'account' };
const LATER = new Date(NOW.getTime() + 3600000);
const raised = T.create({ kind: 'system', title: 'Add X to Beeline' }, actor, NOW);
const handed = T.applyEdit(raised, { assignee: 'Ana Diaz', assigneeEmail: 'ana@geodis.com' },
  manager, LATER);
t('the owner is set', handed.assignee === 'Ana Diaz');
t('and joined to the account, not just to the name', handed.assigneeEmail === 'ana@geodis.com');
t('an assignment does not move the status', handed.status === undefined);
t('but it does restart the clock, so the new owner gets the whole window',
  handed.updatedAt === LATER.toISOString());
t('and it says in the log who put them on it',
  handed.statusHistory[handed.statusHistory.length - 1].note === 'Assigned to Ana Diaz' &&
  handed.statusHistory[handed.statusHistory.length - 1].by === 'Mo');
t('the log entry carries the status it was already in, not a blank',
  handed.statusHistory[handed.statusHistory.length - 1].status === 'Open');

const owned = T.normalize(Object.assign({}, raised, handed));
const overridden = T.applyEdit(owned, { status: 'Complete', note: 'Beeline shows him active' },
  manager, LATER);
t('a status override moves the status', overridden.status === 'Complete');
t('attributed to whoever overrode it', overridden.statusUpdatedBy === 'Mo');
t('with the reason on the log entry, which is the whole point of asking for one',
  overridden.statusHistory[overridden.statusHistory.length - 1].note === 'Beeline shows him active');
t('and it leaves the owner where they were',
  overridden.assignee === 'Ana Diaz' && overridden.assigneeEmail === 'ana@geodis.com');

const both = T.applyEdit(owned, { assignee: '', assigneeEmail: '', status: 'Blocked' }, manager, LATER);
t('taking somebody off it and blocking it is one patch, not two',
  both.assignee === '' && both.status === 'Blocked');
t('and one log entry, so the two can never disagree about what happened',
  both.statusHistory.length === owned.statusHistory.length + 1);
t('which says they came off it', /Left unassigned/.test(both.statusHistory[both.statusHistory.length - 1].note));

t('a field left out of the changes is left alone',
  T.applyEdit(owned, { status: 'Blocked' }, manager, LATER).assignee === 'Ana Diaz');
t('opening the dialog and changing nothing writes nothing',
  T.applyEdit(owned, { assigneeEmail: 'ana@geodis.com', assignee: 'Ana Diaz', status: 'Open' },
    manager, LATER) === null);
t('a note on its own is still worth recording',
  !!T.applyEdit(owned, { status: 'Open', note: 'chased on Teams' }, manager, LATER));
t('an assignee email is stored lowercase, so the join is not case-sensitive',
  T.applyEdit(raised, { assignee: 'Ana', assigneeEmail: 'Ana@Geodis.com' }, manager, LATER)
    .assigneeEmail === 'ana@geodis.com');
t('and a task carries the field even when nobody has been put on it',
  'assigneeEmail' in T.normalize({ id: 'z', kind: 'note' }));

console.log('— the queue —');
const queue = [task('note', 1), task('payroll', 9), task('note', 60), task('note', 30)];
const sorted = T.sort(queue, NOW);
t('urgent work comes first', T.urgencyOf(sorted[0], NOW) === T.URGENT);
t('and the longest-waiting of those is at the top', sorted[0].kind === 'note' && sorted[0].id === 'xnote60');
t('the calm one is last', sorted[sorted.length - 1].id === 'xnote1');
const sum = T.summarize(queue.concat([task('note', 500, 'Complete')]), NOW);
t('the summary counts urgent', sum.urgent === 2);
t('open excludes the completed one', sum.open === 4 && sum.complete === 1);
t('and it is counted by kind', sum.byKind.note === 4 && sum.byKind.payroll === 1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
