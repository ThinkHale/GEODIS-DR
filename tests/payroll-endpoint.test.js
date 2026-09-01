/* The payroll endpoints, run against the real source in functions/index.js:
   ?discrepancyIntake=1 for the form, ?payroll=1 for Beeline hours. */
const fs = require('fs');
const path = require('path');
const Sched = require('../schedule-core.js');
const Intake = require('../form-intake.js');
const TimeOff = require('../timeoff-core.js');
const Payroll = require('../payroll-core.js');
const Core = require('../reconcile-core.js');

let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
/* The browser-facing halves of these handlers sit behind requireUser() now.
   The definition lives outside the slice each harness pulls, so the shared
   stub is injected -- same shape, same status codes. See fn-auth.js. */
const { makeAuth, reqGet } = require('./fn-auth.js');
const auth = makeAuth();
const consts = src.slice(src.indexOf('const COLLECTIONS = {'), src.indexOf('const NOTES_ORIGIN'));
const helpers = src.slice(src.indexOf('async function readJsonArray'), src.indexOf('async function handleCollection'));
const dated = src.slice(src.indexOf('function dateKeyOf'), src.indexOf('/* GET  ?schedule=1'));
/* Sliced up to the auth section, not to the end of the file: past this point
   the source defines the REAL requireUser, which would shadow the injected stub
   and then need the Admin SDK and the whole COLLECTIONS map to run. The real
   one is exercised by collections.test.js, which pulls it in on purpose. */
const handlers = src.slice(src.indexOf('async function rosterProfiles'), src.indexOf('/* ---------- who is calling ----------'));

const SNAPSHOT_PATH = 'snapshots/latest.json';
const NOTES_ORIGIN = 'https://geodis.ebtools.pro';
const KEY = 'secret-key';
let files = {};
const bucket = {
  file: p => ({
    save: async body => { files[p] = body; },
    download: async () => { if (!files[p]) { const e = new Error('404'); e.code = 404; throw e; } return [Buffer.from(files[p])]; }
  }),
  getFiles: async ({ prefix }) => [Object.keys(files).filter(k => k.startsWith(prefix)).map(name => ({ name }))]
};
async function readJsonFile(p) { try { return JSON.parse(files[p]); } catch (e) { return {}; } }
function setKvCors() {}
const SYNC_KEY = { value: () => KEY };

const built = new Function(
  'bucket', 'readJsonFile', 'setKvCors', 'SYNC_KEY', 'SNAPSHOT_PATH', 'NOTES_ORIGIN',
  'Sched', 'Intake', 'TimeOff', 'Payroll', 'console', 'requireUser',
  consts + helpers + dated + handlers +
  '\nreturn {handleDiscrepancyIntake, handlePayroll, COLLECTIONS, PAYROLL_DIR};'
)(bucket, readJsonFile, setKvCors, SYNC_KEY, SNAPSHOT_PATH, NOTES_ORIGIN, Sched, Intake, TimeOff, Payroll, console, auth.requireUser);
const { handleDiscrepancyIntake, handlePayroll, COLLECTIONS, PAYROLL_DIR } = built;

const mkRes = () => { const r = { code: null, body: null, set() { return r }, status(c) { r.code = c; return r }, json(b) { r.body = b; return r }, send() { return r } }; return r; };
const call = async (h, req) => { const res = mkRes(); await h(req, res); return res; };
const intake = (body, key) => call(handleDiscrepancyIntake,
  { method: 'POST', body, get: hh => (hh === 'x-sync-key' ? (key === undefined ? KEY : key) : '') });
/* A signed-in browser, unless a test says otherwise. Automation posts its hours
   with the sync key and no token, which is a different door and still open. */
const payroll = (method, query, body, hdrs) => call(handlePayroll, {
  method, query: query || {}, body: body || {},
  get: reqGet(Object.assign({ authorization: 'Bearer test-token' }, hdrs || {}))
});
const discrepancies = () => { try { return JSON.parse(files[COLLECTIONS.discrepancies.path]); } catch (e) { return []; } };
const period = w => { try { return JSON.parse(files[PAYROLL_DIR + '/' + w + '.json']); } catch (e) { return {}; } };

files[SNAPSHOT_PATH] = JSON.stringify({
  records: [{ badge: '215001', person: 'Luz Grachen', market: 'Chicago' }]
});

(async () => {
  console.log('— discrepancy intake: auth —');
  t('no key rejected', (await intake({ name: 'x' }, '')).code === 401);
  t('nothing written', discrepancies().length === 0);

  console.log('— a submission —');
  let r = await intake({
    name: 'Luz Grachen', location: 'LEGO', date: '8/25/2026',
    details: 'Missing 4 hours Tuesday', responseId: '900'
  });
  t('accepted', r.code === 200 && r.body.written === 1);
  t('matched', r.body.results[0].matched === true);
  let list = discrepancies();
  t('written', list.length === 1);
  t('badge resolved', list[0].badge === '215001');
  t('week ending derived', list[0].weekEnding === '2026-08-30');
  t('details survive the whitelist', list[0].details === 'Missing 4 hours Tuesday');
  t('starts at Received', list[0].status === 'Received');

  console.log('— re-running the flow —');
  await intake({ name: 'Luz Grachen', location: 'LEGO', date: '8/25/2026', details: 'Missing 4 hours Tuesday', responseId: '900' });
  t('does not duplicate', discrepancies().length === 1);
  list = discrepancies(); list[0].status = 'Researching';
  files[COLLECTIONS.discrepancies.path] = JSON.stringify(list);
  await intake({ name: 'Luz Grachen', location: 'LEGO', date: '8/25/2026', details: 'Missing 4 hours Tuesday', responseId: '900' });
  t('and does not drag it back to Received', discrepancies()[0].status === 'Researching');

  console.log('— the raw Forms body works here too —');
  r = await intake({
    responseId: '901',
    fields: { name: 'rN', location: 'rL', date: 'rD', details: 'rX' },
    response: { rN: 'Luz Grachen', rL: 'Redbull', rD: '2026-09-01', rX: 'Overtime\nnot paid' }
  });
  t('accepted', r.code === 200);
  const viaMap = discrepancies().find(x => x.id === 'PDF-901');
  t('fields picked out by question id', viaMap.location === 'Redbull');
  t('a newline in the details is fine', viaMap.details.indexOf('\n') !== -1);
  t('missing name still caught', (await intake({ fields: { name: 'rN' }, response: {} })).body.results[0].error === 'Missing name');

  console.log('— hours: posting a pull —');
  const W = '2026-08-30';
  t('GET index needs an account', (await payroll('GET', {})).code === 200);
  t('and is refused without one',
    (await call(handlePayroll, { method: 'GET', query: {}, body: {}, get: reqGet({}) })).code === 401);
  t('writing hours needs the sync key',
    (await payroll('POST', { week: W }, { rows: [] }, {})).code === 401);
  r = await payroll('POST', { week: W },
    { rows: [{ badge: '215001', name: 'Luz Grachen', hours: 40 }, { badge: '2', name: 'B', hours: 38 }], takenAt: '2026-08-31T09:00:00Z' },
    { 'x-sync-key': KEY });
  t('accepted', r.code === 200);
  t('the first pull is a baseline', r.body.baseline === true);
  t('so no changes', r.body.changes === 0);
  t('stored under the week', !!files[PAYROLL_DIR + '/' + W + '.json']);
  t('one snapshot', period(W).snapshots.length === 1);
  t('rows kept on the latest', period(W).snapshots[0].rows.length === 2);

  console.log('— setting the close date is a person, not an automation —');
  t('a browser origin is required',
    (await payroll('POST', { week: W }, { closesAt: '2026-09-01T17:00:00Z' }, {})).code === 403);
  r = await payroll('POST', { week: W }, { closesAt: '2026-09-01T17:00:00Z' }, { origin: NOTES_ORIGIN });
  t('accepted from the app', r.code === 200);
  t('recorded', period(W).closesAt === '2026-09-01T17:00:00Z');
  t('and the snapshot survived it', period(W).snapshots.length === 1);

  console.log('— a later pull, after close —');
  r = await payroll('POST', { week: W },
    { rows: [{ badge: '215001', name: 'Luz Grachen', hours: 44 }, { badge: '3', name: 'C', hours: 8 }], takenAt: '2026-09-02T15:00:00Z' },
    { 'x-sync-key': KEY });
  t('changes detected', r.body.changes === 3);
  t('flagged as after close', r.body.afterClose === true);
  t('two snapshots now', period(W).snapshots.length === 2);
  t('only the latest keeps its rows', period(W).snapshots[0].rows === undefined);
  t('the older one keeps its summary', !!period(W).snapshots[0].summary);
  t('changes accumulate on the period', period(W).changes.length === 3);
  t('every change carries the flag', period(W).changes.every(c => c.afterClose === true));

  console.log('— reading it back —');
  r = await payroll('GET', { week: W });
  t('period read back', r.body.period.snapshots.length === 2);
  r = await payroll('GET', {});
  t('the week is in the index', r.body.periods.indexOf(W) !== -1);

  console.log('— guards —');
  t('bad week refused', (await payroll('POST', { week: '../x' }, { rows: [] }, { 'x-sync-key': KEY })).code === 400);
  t('neither rows nor closesAt refused',
    (await payroll('POST', { week: W }, { junk: 1 }, { 'x-sync-key': KEY })).code === 400);
  t('oversized pull refused',
    (await payroll('POST', { week: W }, { rows: new Array(20001).fill({ badge: '1', hours: 1 }) }, { 'x-sync-key': KEY })).code === 400);
  t('a week with nothing stored is empty, not an error', (await payroll('GET', { week: '2020-01-05' })).code === 200);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
