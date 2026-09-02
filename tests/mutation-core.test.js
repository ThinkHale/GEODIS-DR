/* Optimistic save, rollback and Undo state (mutation-core.js). */
const M = require('../mutation-core.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let pass = 0, fail = 0;
const t = (name, condition) => {
  if (condition) pass++;
  else { fail++; console.log('  FAIL: ' + name); }
};

let now = Date.parse('2026-09-01T12:00:00.000Z');
const machine = M.createMachine({
  clock: () => now,
  undoMs: 5000,
  label: 'shift assignment'
});

console.log('— initial and saving state —');
const idle = machine.initial('Day');
t('initial state is idle', idle.status === M.IDLE && idle.value === 'Day');
t('initial state carries no false success message', machine.feedbackText(idle) === '');
const saving = machine.begin(idle, 'Night', { compensatingAction: { type: 'restore-shift', value: 'Day' } });
t('begin applies the optimistic value', saving.status === M.SAVING && saving.value === 'Night');
t('the previous value is retained for rollback', saving.previousValue === 'Day');
t('the attempted value is explicit', saving.attemptedValue === 'Night');
t('the deterministic clock stamps the attempt', saving.startedAt === '2026-09-01T12:00:00.000Z');
t('transitions do not mutate their input', idle.status === M.IDLE && idle.value === 'Day' && idle.revision === 0);
t('saving is exposed as busy', machine.isBusy(saving));
let feedback = machine.feedback(saving);
t('saving feedback is concise plain text', feedback.message === 'Saving shift assignment…');
t('progress uses a polite live status', feedback.role === 'status' && feedback.ariaLive === 'polite' && feedback.ariaAtomic === true);
t('a second edit cannot replace an in-flight value', machine.begin(saving, 'Weekend') === saving);

console.log('— saved state and its Undo window —');
now += 1000;
const saved = machine.succeed(saving, { revision: saving.revision });
t('success becomes saved', saved.status === M.SAVED && saved.result === 'saved');
t('success keeps the committed value and its predecessor', saved.value === 'Night' && saved.previousValue === 'Day');
t('the save time is deterministic', saved.savedAt === '2026-09-01T12:00:01.000Z');
t('the Undo deadline is exact', saved.undoUntil === '2026-09-01T12:00:06.000Z');
t('Undo is available inside the window', machine.canUndo(saved));
t('saved feedback announces the remaining window',
  machine.feedbackText(saved) === 'Shift assignment saved. Undo available for 5 seconds.');
now = Date.parse('2026-09-01T12:00:05.001Z');
t('feedback rounds the final fraction up to one second',
  machine.feedbackText(saved) === 'Shift assignment saved. Undo available for 1 second.');
now = Date.parse('2026-09-01T12:00:06.000Z');
t('Undo is closed at the deadline, not one tick after it', !machine.canUndo(saved));
t('expired feedback no longer offers an action', machine.feedbackText(saved) === 'Shift assignment saved.');
const expired = machine.requestUndo(saved);
t('an expired Undo is rejected with a reason', !expired.accepted && expired.reason === 'expired');
t('rejecting an expired Undo clears its action',
  expired.state.undoUntil === '' && expired.state.compensatingAction === null && expired.action === null);

console.log('— compensating action and successful Undo —');
let actionCalls = 0;
const compensate = () => { actionCalls++; };
now = Date.parse('2026-09-01T13:00:00.000Z');
const secondSave = machine.succeed(machine.begin(saved, 'Weekend', { compensate }));
now += 2000;
const undo = machine.requestUndo(secondSave);
t('Undo is accepted while the window is open', undo.accepted && undo.reason === '');
t('the core returns, but never executes, the compensating action',
  undo.action === compensate && actionCalls === 0);
t('Undo optimistically restores the previous value',
  undo.state.status === M.SAVING && undo.state.operation === M.UNDO && undo.state.value === 'Night');
t('Undo keeps the saved value as its own rollback target', undo.state.previousValue === 'Weekend');
t('Undo has accessible progress feedback', machine.feedbackText(undo.state) === 'Undoing shift assignment…');
now += 500;
const restored = machine.succeed(undo.state, { revision: undo.revision });
t('a successful compensation leaves the prior value restored',
  restored.status === M.SAVED && restored.result === 'undone' && restored.value === 'Night');
t('Undo is one-shot rather than an accidental redo', !machine.canUndo(restored) && restored.compensatingAction === null);
t('restoration is announced plainly', machine.feedbackText(restored) === 'Shift assignment restored.');

console.log('— failed save rolls back —');
now = Date.parse('2026-09-01T14:00:00.000Z');
const beforeFailure = machine.initial({ status: 'Open' }, { label: 'task status' });
const optimistic = machine.begin(beforeFailure, { status: 'Complete' });
now += 250;
const failed = machine.fail(optimistic, { message: 'Connection lost', status: 503, code: 'offline' });
t('failure enters an explicit error state', failed.status === M.ERROR && failed.result === 'save-error');
t('failure rolls the optimistic value back', failed.value === beforeFailure.value);
t('the failed value remains inspectable', failed.attemptedValue.status === 'Complete');
t('structured error details are retained',
  failed.error.message === 'Connection lost' && failed.error.status === 503 && failed.error.code === 'offline');
t('failure time uses the injected clock', failed.failedAt === '2026-09-01T14:00:00.250Z');
feedback = machine.feedback(failed);
t('failure tells the person the prior value was restored',
  feedback.message === 'Could not save task status. Previous value restored. Connection lost');
t('failure is an assertive accessible alert', feedback.role === 'alert' && feedback.ariaLive === 'assertive');
t('errors cannot offer Undo', !machine.canUndo(failed));

console.log('— failed Undo restores the saved value —');
now = Date.parse('2026-09-01T15:00:00.000Z');
const undoable = machine.succeed(machine.begin(machine.initial('Open', { label: 'task status' }),
  'Complete', { compensate: { method: 'save', value: 'Open' } }));
now += 100;
const undoAttempt = machine.requestUndo(undoable);
now += 100;
const undoFailed = machine.fail(undoAttempt.state, new Error('Still offline'));
t('a failed Undo is distinguishable from a failed save', undoFailed.result === 'undo-error');
t('a failed Undo rolls back to the last saved value', undoFailed.value === 'Complete');
t('Undo failure feedback explains that rollback',
  machine.feedbackText(undoFailed) === 'Could not undo task status. Saved value restored. Still offline');

console.log('— transition guards and configuration —');
const noUndo = machine.succeed(machine.begin(machine.initial('A'), 'B'));
t('a save without a compensating action has no Undo', !machine.canUndo(noUndo));
t('requesting unavailable Undo is a safe no-op',
  machine.requestUndo(noUndo).reason === 'unavailable' && machine.requestUndo(noUndo).state === noUndo);
t('a stale success revision cannot overwrite newer state',
  machine.succeed(optimistic, { revision: optimistic.revision + 1 }) === optimistic);
t('a stale failure revision cannot roll back newer state',
  machine.fail(optimistic, 'late error', { revision: optimistic.revision + 1 }) === optimistic);

const custom = M.create({ clock: () => new Date('2026-09-02T00:00:00Z'), undoMs: 9000 });
const customIdle = custom.initial('A', { undoMs: 12000 });
const customSaving = custom.begin(customIdle, 'B', { compensate: 'restore-A' });
const customSaved = custom.succeed(customSaving, { at: '2026-09-02T00:00:01Z' });
t('a per-mutation Undo duration survives begin', customSaved.undoUntil === '2026-09-02T00:00:13.000Z');
t('an explicit transition time overrides the injected clock', customSaved.savedAt === '2026-09-02T00:00:01.000Z');
t('the CommonJS API also exposes convenient default-machine functions',
  typeof M.begin === 'function' && typeof M.requestUndo === 'function' && M.DEFAULT_UNDO_MS === 5000);

let clockReads = 0;
const counted = M.create({ clock: () => {
  clockReads++;
  return Date.parse('2026-09-03T00:00:01Z');
} });
const countedState = counted.succeed(counted.begin(counted.initial('A'), 'B', {
  at: '2026-09-03T00:00:00Z', compensate: 'restore-A'
}), { at: '2026-09-03T00:00:00Z' });
counted.feedback(countedState);
t('one feedback calculation reads the injected clock once', clockReads === 1);

const browser = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'mutation-core.js'), 'utf8'), browser);
t('the UMD build publishes MutationCore in a browser',
  browser.window.MutationCore && typeof browser.window.MutationCore.createMachine === 'function');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
