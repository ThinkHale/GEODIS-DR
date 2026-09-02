/* Last-good client data and per-source load metadata (suite-data.js). */
const assert = require('assert');

let responder = null;
global.fetch = (url, opts) => Promise.resolve().then(() => responder(String(url), opts || {}));

delete require.cache[require.resolve('../suite-data.js')];
const { SuiteData: SD } = require('../suite-data.js');

const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(data)
});

let passed = 0;
function t(name, condition) {
  assert.ok(condition, name);
  passed++;
  console.log('  ok - ' + name);
}

(async () => {
  console.log('— a successful collection is authoritative —');
  responder = () => response({ attendance: [{ id: 'A1', badge: '1001' }] });
  const first = await SD.loadCollection('attendance');
  const ready = SD.getSourceState('attendance');
  t('the server rows are returned', first.length === 1 && first[0].id === 'A1');
  t('the source is ready', ready.status === 'ready' && ready.hasData === true);
  t('the client records when the source loaded', !!ready.loadedAt && !!ready.attemptedAt);
  t('a successful source has no error', ready.error === null && ready.failedAt === '');

  console.log('— a failed refresh keeps the last successful value —');
  first[0].id = 'MUTATED-BY-CALLER';
  responder = () => Promise.reject(new Error('network offline'));
  const fallback = await SD.loadCollection('attendance');
  const stale = SD.getSourceState('attendance');
  t('the last-good rows are returned', fallback.length === 1 && fallback[0].id === 'A1');
  t('caller mutation did not poison the cache', fallback[0].id !== first[0].id);
  t('the source is marked stale, not ready or empty', stale.status === 'stale' && stale.hasData === true);
  t('the original loaded-at time survives the failure', stale.loadedAt === ready.loadedAt);
  t('the refresh error is exposed', stale.error.message === 'network offline' && !!stale.failedAt);

  console.log('— a first-load failure never becomes an empty collection —');
  let firstFailure = null;
  try { await SD.loadCollection('timeoff'); } catch (err) { firstFailure = err; }
  const failed = SD.getSourceState('timeoff');
  t('the failed request rejects', !!firstFailure && firstFailure.source === 'timeoff');
  t('there is no invented last-good data', failed.status === 'error' && failed.hasData === false);
  t('the source error remains inspectable', failed.error.message === 'network offline' && failed.loadedAt === '');

  console.log('— an empty collection is authoritative only after success —');
  responder = () => response({ requisitions: [] });
  const empty = await SD.loadCollection('requisitions');
  const emptyState = SD.getSourceState('requisitions');
  t('a successful empty collection returns an empty list', Array.isArray(empty) && empty.length === 0);
  t('the successful empty source is ready, not failed', emptyState.status === 'ready' && emptyState.hasData === true);

  console.log('— authorization failures do not serve cached workforce data —');
  responder = () => response({ tasks: [{ id: 'T1' }] });
  await SD.loadCollection('tasks');
  responder = () => response({ error: 'Forbidden' }, 403);
  let denied = null;
  try { await SD.loadCollection('tasks'); } catch (err) { denied = err; }
  const deniedState = SD.getSourceState('tasks');
  t('the denied refresh rejects despite a cache', !!denied && denied.denied === 403);
  t('authorization is a distinct source state', deniedState.status === 'denied' && deniedState.error.denied === true);
  t('metadata acknowledges prior data without returning it', deniedState.hasData === true && !!deniedState.loadedAt);

  console.log('— non-collection sources use the same contract —');
  responder = () => response({ periods: ['2026-08-30'] });
  const periods = await SD.loadPayrollPeriods();
  const periodsReady = SD.getSourceState('payrollPeriods');
  responder = () => Promise.reject(new Error('timeout'));
  const oldPeriods = await SD.loadPayrollPeriods();
  const periodsStale = SD.getSourceState('payrollPeriods');
  t('payroll periods load normally', periods[0] === '2026-08-30');
  t('their last-good value survives a timeout', oldPeriods[0] === '2026-08-30');
  t('their metadata names the failed source', periodsStale.source === 'payrollPeriods' && periodsStale.status === 'stale');
  t('loaded-at remains the successful load time', periodsStale.loadedAt === periodsReady.loadedAt);

  console.log('— public state is a defensive copy —');
  const states = SD.getSourceStates();
  states.attendance.error.message = 'changed outside';
  t('callers cannot mutate internal error metadata', SD.getSourceState('attendance').error.message === 'network offline');
  t('untouched sources report idle', SD.getSourceState('never-loaded').status === 'idle');

  console.log('\n' + passed + ' passed, 0 failed');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
