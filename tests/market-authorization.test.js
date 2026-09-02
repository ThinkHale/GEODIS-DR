/* Exercise the shipped collection and snapshot handlers against fake Storage.
   These are endpoint tests: the token/account gate, market policy, persistence,
   response shaping, and safe bulk merge all run from functions/index.js. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
const { makeAuth, reqGet } = require('./fn-auth.js');
const auth = makeAuth();
const MarketAccess = require('../functions/market-access-core.js');
const TransitionPto = require('../functions/transition-pto.js');

const collBlock = src.slice(src.indexOf('const COLLECTIONS = {'), src.indexOf('const NOTES_ORIGIN'));
const handler = src.slice(src.indexOf('async function readJsonArray'), src.indexOf('function parseToState'));
const NOTES_ORIGIN = 'https://geodis.ebtools.pro';
const SNAPSHOT_PATH = 'snapshots/latest.json';
let stored = {};
const bucket = {
  file: p => ({
    save: async body => { stored[p] = body; },
    download: async () => {
      if (stored[p] === undefined) { const err = new Error('Not found'); err.code = 404; throw err; }
      return [Buffer.from(stored[p])];
    }
  })
};
async function readJsonFile(p) { return stored[p] === undefined ? {} : JSON.parse(stored[p]); }
function setKvCors() {}

const fn = new Function('bucket', 'NOTES_ORIGIN', 'SNAPSHOT_PATH', 'readJsonFile',
  'setKvCors', 'console', 'admin', 'Auth', 'MarketAccess', 'TransitionPto',
  collBlock + '\n' + handler +
  '\nreturn {COLLECTIONS,handleCollection,handleSnapshot};');
const { COLLECTIONS, handleCollection, handleSnapshot } = fn(bucket, NOTES_ORIGIN,
  SNAPSHOT_PATH, readJsonFile, setKvCors, console, auth.admin, auth.Auth, MarketAccess, TransitionPto);

let pass = 0, fail = 0;
const t = (name, condition) => {
  if (condition) pass++;
  else { fail++; console.log('  FAIL: ' + name); }
};
const mkRes = () => {
  const r = { code: null, body: null,
    set() { return r; }, type() { return r; },
    status(code) { r.code = code; return r; },
    json(body) { r.body = body; return r; },
    send(body) { r.body = body; return r; }
  };
  return r;
};
const headers = () => ({ origin: NOTES_ORIGIN, authorization: 'Bearer test-token' });
const setActor = account => {
  auth.as(account);
  const users = JSON.parse(stored['admin/users.json'] || '[]').filter(u => u.email !== account.email);
  users.push(Object.assign({ id: account.email }, account));
  stored['admin/users.json'] = JSON.stringify(users);
};
const get = async name => {
  const res = mkRes();
  await handleCollection({ method: 'GET', get: reqGet(headers()) }, res, COLLECTIONS[name]);
  return res;
};
const post = async (name, body) => {
  const res = mkRes();
  await handleCollection({ method: 'POST', body, get: reqGet(headers()) }, res, COLLECTIONS[name]);
  return res;
};
const getSnapshot = async () => {
  const res = mkRes();
  await handleSnapshot({ method: 'GET', get: reqGet(headers()) }, res);
  return res;
};
const rows = name => JSON.parse(stored[COLLECTIONS[name].path] || '[]');

stored[SNAPSHOT_PATH] = JSON.stringify({
  updatedAt: '2026-09-01T12:00:00Z',
  counts: { matched: 2, addBeeline: 2, dups: 0, total: 4, needsAction: 2 },
  records: [
    { badge: 'C1', person: 'Chi One', market: 'Chicago', action: 'matched' },
    { badge: 'C2', person: 'Chi Two', market: 'Chicago', action: 'addBeeline' },
    { badge: 'S1', person: 'St Louis', market: 'St. Louis', action: 'addBeeline' },
    { badge: 'U1', person: 'Unassigned', market: '', action: 'matched' }
  ]
});
stored['attendance/events.json'] = JSON.stringify([
  { id: 'a-chi', badge: 'C1', type: 'Absent', points: 1 },
  { id: 'a-stl', badge: 'S1', type: 'Absent', points: 1 },
  { id: 'a-unassigned', badge: 'U1', type: 'Absent', points: 1 },
  { id: 'a-unknown', badge: 'NOPE', type: 'Absent', points: 1 }
]);
stored['requisitions/requisitions.json'] = JSON.stringify([
  { id: 'r-chi', title: 'Chicago', market: 'Chicago' },
  { id: 'r-stl', title: 'St Louis', market: 'St. Louis' },
  { id: 'r-none', title: 'No market', market: '' }
]);
stored['admin/config.json'] = JSON.stringify([{ id: 'rc', key: 'rcBaseUrl', value: 'secret-ish' }]);
stored['associates/pto.json'] = JSON.stringify([
  { id: 'pto-chi', badge: 'C1', transitionAssociate: 'true', transitionPtoBalance: 8 },
  { id: 'pto-stl', badge: 'S1', transitionAssociate: 'true', transitionPtoBalance: 8 }
]);
setActor({ email: 'chi-admin@geodis.com', name: 'Chi Admin', role: 'admin', enabled: true, markets: ['Chicago'] });

(async () => {
  console.log('— restricted collection and snapshot reads —');
  let response = await get('attendance');
  t('collection GET succeeds', response.code === 200);
  t('only badge records resolved to the authorized market are returned',
    response.body.attendance.map(r => r.id).join(',') === 'a-chi');
  response = await get('requisitions');
  t('explicit-market records are scoped and blank rows are hidden',
    response.body.requisitions.map(r => r.id).join(',') === 'r-chi');
  response = await get('appConfig');
  t('a collection with no market ownership returns no rows to a restricted account',
    response.code === 200 && response.body.appConfig.length === 0);

  response = await getSnapshot();
  t('snapshot GET succeeds', response.code === 200);
  t('snapshot excludes other-market and blank-market associates',
    response.body.records.map(r => r.badge).join(',') === 'C1,C2');
  t('snapshot aggregates are recomputed from visible rows',
    response.body.counts.total === 2 && response.body.counts.matched === 1 &&
    response.body.counts.addBeeline === 1 && response.body.counts.needsAction === 1);

  console.log('— restricted single-record writes —');
  response = await post('attendance', { id: 'a-chi-2', badge: 'C2', type: 'Late', points: 0.5 });
  t('an authorized insert is stored', response.code === 200 && rows('attendance').some(r => r.id === 'a-chi-2'));
  t('write response count reveals only the authorized partition', response.body.count === 2);

  response = await post('timeoff',
    { id: 'time-chi', badge: 'C1', type: 'PTO', status: 'Received', hours: 8 });
  t('a related collection returned after a write is market scoped too',
    response.code === 200 && response.body.associatePto.length === 1 &&
    response.body.associatePto[0].id === 'pto-chi');
  t('filtering the response does not erase the other market from storage',
    rows('associatePto').some(r => r.id === 'pto-stl'));

  let before = stored['attendance/events.json'];
  response = await post('attendance', { id: 'a-stl-new', badge: 'S1', type: 'Late' });
  t('an other-market insert is forbidden', response.code === 403);
  t('the rejected insert changes nothing', stored['attendance/events.json'] === before);

  response = await post('attendance', { id: 'a-blank-new', badge: 'NOPE', type: 'Late' });
  t('an unresolved insert is forbidden', response.code === 403);
  t('the unresolved insert changes nothing', stored['attendance/events.json'] === before);

  response = await post('attendance', { id: 'a-stl', points: 9 });
  t('an existing other-market row cannot be updated by id', response.code === 403);
  t('the cross-market update changes nothing', stored['attendance/events.json'] === before);

  response = await post('attendance', { id: 'a-stl', _delete: true });
  t('an existing other-market row cannot be deleted by id', response.code === 403);
  t('the cross-market delete changes nothing', stored['attendance/events.json'] === before);

  console.log('— restricted bulk replacement —');
  response = await post('attendance', { records: [
    { id: 'chi-replacement', badge: 'C1', type: 'Present', points: 0 }
  ] });
  const afterMerge = rows('attendance');
  t('authorized market bulk replacement succeeds', response.code === 200);
  t('the prior authorized partition is replaced',
    !afterMerge.some(r => r.id === 'a-chi') && !afterMerge.some(r => r.id === 'a-chi-2') &&
    afterMerge.some(r => r.id === 'chi-replacement'));
  t('bulk replacement preserves other-market and unassigned records',
    ['a-stl', 'a-unassigned', 'a-unknown'].every(id => afterMerge.some(r => r.id === id)));
  t('bulk response count does not leak preserved records', response.body.count === 1);

  before = stored['attendance/events.json'];
  response = await post('attendance', { records: [{ id: 'bad-stl', badge: 'S1', type: 'Late' }] });
  t('bulk payload containing another market is rejected atomically',
    response.code === 403 && stored['attendance/events.json'] === before);
  response = await post('attendance', { records: [{ id: 'a-stl', badge: 'C1', type: 'Late' }] });
  t('bulk cannot overwrite a preserved other-market id',
    response.code === 403 && stored['attendance/events.json'] === before);

  console.log('— unrestricted compatibility —');
  setActor({ email: 'all-admin@geodis.com', name: 'All Admin', role: 'admin', enabled: true, markets: [] });
  response = await get('attendance');
  t('unrestricted GET retains every stored market and unassigned row',
    response.body.attendance.length === rows('attendance').length);
  response = await getSnapshot();
  t('unrestricted snapshot retains all records and original aggregate',
    response.body.records.length === 4 && response.body.counts.total === 4);
  response = await post('attendance', { records: [{ id: 'only', badge: 'C1', type: 'Present' }] });
  t('unrestricted bulk remains a complete replacement',
    response.code === 200 && rows('attendance').length === 1 && rows('attendance')[0].id === 'only');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
