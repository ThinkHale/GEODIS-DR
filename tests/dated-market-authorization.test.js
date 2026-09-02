/* Direct endpoint bypass tests for the date-partitioned schedule, coverage and
   payroll stores. The shipped handlers are evaluated against fake Storage; the
   only substituted boundary is Firebase identity verification (fn-auth.js). */
const fs = require('fs');
const path = require('path');
const { makeAuth, reqGet } = require('./fn-auth.js');
const MarketAccess = require('../functions/market-access-core.js');
const Payroll = require('../functions/payroll-core.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
const constants = src.slice(src.indexOf('const COLLECTIONS = {'), src.indexOf('const NOTES_ORIGIN'));
const collectionHelpers = src.slice(src.indexOf('async function readJsonArray'), src.indexOf('async function handleCollection'));
const datedHandlers = src.slice(src.indexOf('function dateKeyOf'), src.indexOf('/* ---------- PTO requests'));
const payrollHandler = src.slice(src.indexOf('async function handlePayroll'), src.indexOf('/* ---------- the live PLX workbook'));

const NOTES_ORIGIN = 'https://geodis.ebtools.pro';
const SNAPSHOT_PATH = 'snapshots/latest.json';
const KEY = 'test-sync-key';
const auth = makeAuth();
let stored = {};
const bucket = {
  file: p => ({
    save: async body => { stored[p] = body; },
    download: async () => {
      if (stored[p] === undefined) { const err = new Error('Not found'); err.code = 404; throw err; }
      return [Buffer.from(stored[p])];
    }
  }),
  getFiles: async ({ prefix }) => [Object.keys(stored).filter(p => p.startsWith(prefix)).map(name => ({ name }))]
};
async function readJsonFile(p) {
  if (stored[p] === undefined) return {};
  try { return JSON.parse(stored[p]); } catch (err) { return {}; }
}
function setKvCors() {}
const SYNC_KEY = { value: () => KEY };

const built = new Function(
  'bucket', 'readJsonFile', 'setKvCors', 'SYNC_KEY', 'SNAPSHOT_PATH', 'NOTES_ORIGIN',
  'Payroll', 'MarketAccess', 'requireUser', 'console',
  constants + '\n' + collectionHelpers + '\n' + datedHandlers + '\n' + payrollHandler +
  '\nreturn {handleSchedule,handleCoverage,handlePayroll,COLLECTIONS,SCHEDULE_DIR,COVERAGE_DIR,PAYROLL_DIR};'
)(bucket, readJsonFile, setKvCors, SYNC_KEY, SNAPSHOT_PATH, NOTES_ORIGIN,
  Payroll, MarketAccess, auth.requireUser, console);
const { handleSchedule, handleCoverage, handlePayroll, COLLECTIONS,
  SCHEDULE_DIR, COVERAGE_DIR, PAYROLL_DIR } = built;

let pass = 0, fail = 0;
const t = (name, condition) => {
  if (condition) pass++;
  else { fail++; console.log('  FAIL: ' + name); }
};
const mkRes = () => {
  const r = { code: null, body: null,
    set() { return r; }, status(code) { r.code = code; return r; },
    json(body) { r.body = body; return r; }, send(body) { r.body = body; return r; }
  };
  return r;
};
async function call(handler, method, query, body, headers) {
  const res = mkRes();
  await handler({
    method: method, query: query || {}, body: body || {},
    get: reqGet(Object.assign({ authorization: 'Bearer test-token', origin: NOTES_ORIGIN }, headers || {}))
  }, res);
  return res;
}
const raw = p => stored[p];
const json = p => JSON.parse(stored[p] || '{}');

const WEEK = '2026-08-23';
const DAY = '2026-08-25';
const PAY_WEEK = '2026-08-30';
const schedulePath = SCHEDULE_DIR + '/' + WEEK + '.json';
const coveragePath = COVERAGE_DIR + '/' + DAY + '.json';
const payrollPath = PAYROLL_DIR + '/' + PAY_WEEK + '.json';
const chiPath = 'GEODIS/US/CL/CHICAGO/1523';
const stlPath = 'GEODIS/US/MO/STLOUIS/2201';
const chiPayrollChange = {
  kind: 'changed', badge: 'C1', location: 'Chicago Site', delta: 2,
  at: '2026-09-01T09:00:00Z'
};
const stlPayrollChange = {
  kind: 'changed', badge: 'S1', location: 'St Louis Site', delta: 2,
  at: '2026-09-01T09:00:00Z'
};
const unassignedPayrollChange = {
  kind: 'changed', badge: 'U1', location: '', delta: 2,
  at: '2026-09-01T09:00:00Z'
};
const chiReviewKey = Payroll.changeKey(chiPayrollChange);
const stlReviewKey = Payroll.changeKey(stlPayrollChange);
const unassignedReviewKey = Payroll.changeKey(unassignedPayrollChange);

stored[SNAPSHOT_PATH] = JSON.stringify({ records: [
  { badge: 'C1', empNumber: 'WC1', person: 'Chi One', market: 'Chicago', marketVerified: true },
  { badge: 'C2', empNumber: 'WC2', person: 'Chi Two', market: 'Chicago', marketVerified: true },
  { badge: 'S1', empNumber: 'WS1', person: 'St Louis One', market: 'St. Louis', marketVerified: true },
  { badge: 'U1', person: 'Unassigned One', market: '', marketVerified: false }
] });
stored[COLLECTIONS.locations.path] = JSON.stringify([
  { id: 'loc-chi', code: '1523', name: 'Chicago Site', market: 'Chicago' },
  { id: 'loc-stl', code: '2201', name: 'St Louis Site', market: 'St. Louis' }
]);
stored[schedulePath] = JSON.stringify({
  periodStart: WEEK, periodEnd: '2026-08-29', fileName: 'mixed-week.xlsx', people: [
    { name: 'Chi One', badge: 'C1', wfmId: 'WC1', location: chiPath, shifts: {} },
    { name: 'Name Only', badge: '', wfmId: '', location: chiPath, shifts: {} },
    { name: 'St Louis One', badge: 'S1', wfmId: 'WS1', location: stlPath, shifts: {} },
    { name: 'Unknown', badge: '', wfmId: '', location: 'Unknown Site', shifts: {} },
    { name: 'Conflict', badge: 'C2', wfmId: '', location: stlPath, shifts: {} }
  ]
});
stored[SCHEDULE_DIR + '/2026-08-30.json'] = JSON.stringify({ periodStart: '2026-08-30', people: [
  { name: 'St Louis One', badge: 'S1', location: stlPath, shifts: {} }
] });

const mixedCheck = {
  id: 'CK-MIXED', asOf: DAY + 'T09:00:00', fileName: 'mixed.csv',
  summary: { total: 99, present: 90, coverage: 97 },
  exceptions: [
    { key: 'b:C2', badge: 'C2', name: 'Chi Two', status: 'missing', location: chiPath },
    { key: 'b:S1', badge: 'S1', name: 'St Louis One', status: 'missing', location: stlPath },
    { key: 'b:U1', badge: 'U1', name: 'Unassigned One', status: 'missing', location: '' }
  ],
  presentKeys: ['b:C1', 'b:S1', 'b:U1', 'n:name only']
};
stored[coveragePath] = JSON.stringify({
  date: DAY, checks: [mixedCheck], documented: {
    'b:C1': { badge: 'C1', name: 'Chi One', reason: 'Chicago note' },
    'b:S1': { badge: 'S1', name: 'St Louis One', reason: 'St Louis note' },
    'b:U1': { badge: 'U1', name: 'Unassigned One', reason: 'Unknown note' }
  }
});
stored[COVERAGE_DIR + '/2026-08-26.json'] = JSON.stringify({ date: '2026-08-26', checks: [{
  id: 'CK-STL', exceptions: [{ key: 'b:S1', badge: 'S1', location: stlPath }], presentKeys: []
}], documented: {} });

stored[payrollPath] = JSON.stringify({
  weekEnding: PAY_WEEK, closesAt: '2026-08-31T17:00:00Z',
  snapshots: [
    { takenAt: '2026-08-30T09:00:00Z', summary: { people: 40, totalHours: 1600 } },
    { takenAt: '2026-09-01T09:00:00Z', summary: { people: 4, totalHours: 150 }, rows: [
      { badge: 'C1', name: 'Chi One', hours: 40, location: 'Chicago Site' },
      { badge: 'S1', name: 'St Louis One', hours: 38, location: 'St Louis Site' },
      { badge: 'U1', name: 'Unassigned One', hours: 36, location: '' },
      { badge: 'C2', name: 'Conflict', hours: 36, location: 'St Louis Site' }
    ] }
  ],
  changes: [chiPayrollChange, stlPayrollChange, unassignedPayrollChange],
  reviews: {
    [chiReviewKey]: { note: 'Chicago review', by: 'Chicago Lead', byId: 'chi@geodis.com' },
    [stlReviewKey]: { note: 'St Louis review', by: 'St Louis Lead', byId: 'stl@geodis.com' },
    [unassignedReviewKey]: { note: 'Unassigned review', by: 'Unknown', byId: 'unknown@geodis.com' }
  }
});
stored[PAYROLL_DIR + '/2026-09-06.json'] = JSON.stringify({ weekEnding: '2026-09-06', snapshots: [{
  takenAt: '2026-09-01T09:00:00Z', summary: { people: 1 },
  rows: [{ badge: 'S1', location: 'St Louis Site', hours: 40 }]
}], changes: [] });

auth.as({ email: 'chi-admin@geodis.com', name: 'Chicago Admin', role: 'admin', enabled: true, markets: ['Chicago'] });

(async () => {
  console.log('— restricted schedule GET/POST bypasses —');
  let response = await call(handleSchedule, 'GET', { period: WEEK });
  t('schedule GET returns only resolvable authorized people', response.code === 200 &&
    response.body.schedule.people.map(p => p.name).join(',') === 'Chi One,Name Only');
  response = await call(handleSchedule, 'GET', {});
  t('schedule period index hides a week with no authorized people',
    response.body.periods.join(',') === WEEK);
  response = await call(handleSchedule, 'GET', { period: '2026-08-30' });
  t('direct schedule GET of another market returns no document metadata',
    response.code === 200 && Object.keys(response.body.schedule).length === 0);

  response = await call(handleSchedule, 'POST', { period: WEEK }, { people: [
    { name: 'Chi Replacement', badge: 'C1', location: chiPath, shifts: {} }
  ] });
  t('authorized schedule partition replacement succeeds', response.code === 200 && response.body.people === 1);
  let scheduleRows = json(schedulePath).people;
  t('schedule replacement removes only the old authorized partition',
    !scheduleRows.some(p => p.name === 'Chi One') && !scheduleRows.some(p => p.name === 'Name Only') &&
    scheduleRows.some(p => p.name === 'Chi Replacement'));
  t('schedule replacement preserves other-market, unresolved, and conflicting rows',
    ['St Louis One', 'Unknown', 'Conflict'].every(name => scheduleRows.some(p => p.name === name)));

  let before = raw(schedulePath);
  response = await call(handleSchedule, 'POST', { period: WEEK }, { people: [
    { name: 'Cross market', badge: 'S1', location: stlPath, shifts: {} }
  ] });
  t('cross-market schedule replacement is forbidden atomically',
    response.code === 403 && raw(schedulePath) === before);
  response = await call(handleSchedule, 'POST', { period: WEEK }, { people: [
    { name: 'No owner', badge: '', location: 'Unknown Site', shifts: {} }
  ] });
  t('unresolved schedule replacement is forbidden atomically',
    response.code === 403 && raw(schedulePath) === before);

  console.log('— restricted coverage GET/POST bypasses —');
  response = await call(handleCoverage, 'GET', { date: DAY });
  const visibleCoverage = response.body.coverage;
  t('coverage GET filters exceptions and present identities', response.code === 200 &&
    visibleCoverage.checks[0].exceptions.map(r => r.badge).join(',') === 'C2' &&
    visibleCoverage.checks[0].presentKeys.join(',') === 'b:C1');
  t('coverage aggregate is recomputed without global counts',
    visibleCoverage.checks[0].summary.total === 2 &&
    visibleCoverage.checks[0].summary.present === 1 &&
    visibleCoverage.checks[0].summary.coverage === null);
  t('coverage documentation is scoped by verified identity',
    Object.keys(visibleCoverage.documented).join(',') === 'b:C1');
  response = await call(handleCoverage, 'GET', {});
  t('coverage date index hides days with no authorized records', response.body.dates.join(',') === DAY);
  response = await call(handleCoverage, 'GET', { date: '2026-08-26' });
  t('direct coverage GET of another market returns no document metadata',
    response.code === 200 && Object.keys(response.body.coverage).length === 0);

  before = raw(coveragePath);
  response = await call(handleCoverage, 'POST', { date: DAY }, { document: {
    key: 'b:S1', badge: 'S1', reason: 'overwrite attempt'
  } });
  t('cross-market documentation write is forbidden with no mutation',
    response.code === 403 && raw(coveragePath) === before);
  response = await call(handleCoverage, 'POST', { date: DAY }, { document: {
    key: 'b:U1', badge: 'U1', reason: 'unassigned attempt'
  } });
  t('unresolved documentation write is forbidden with no mutation',
    response.code === 403 && raw(coveragePath) === before);
  response = await call(handleCoverage, 'POST', { date: DAY }, { document: {
    key: 'b:C1', badge: 'C1', name: 'Chi One', reason: 'updated Chicago note'
  } });
  t('authorized documentation update succeeds and preserves other markets',
    response.code === 200 && json(coveragePath).documented['b:C1'].reason === 'updated Chicago note' &&
    json(coveragePath).documented['b:S1'].reason === 'St Louis note');

  before = raw(coveragePath);
  response = await call(handleCoverage, 'POST', { date: DAY }, { check: {
    id: 'CK-MIXED', asOf: DAY + 'T09:00:00',
    exceptions: [{ key: 'b:C2', badge: 'C2', location: chiPath }], presentKeys: ['b:C1']
  } });
  t('same-id check cannot replace a check containing another market',
    response.code === 403 && raw(coveragePath) === before);
  response = await call(handleCoverage, 'POST', { date: DAY }, { check: {
    id: 'CK-CHI', asOf: DAY + 'T10:00:00',
    exceptions: [{ key: 'b:C2', badge: 'C2', status: 'missing', location: chiPath }],
    presentKeys: ['b:C1']
  } });
  t('a new wholly authorized check is appended without removing the mixed check',
    response.code === 200 && json(coveragePath).checks.length === 2 &&
    json(coveragePath).checks.some(check => check.id === 'CK-MIXED'));
  before = raw(coveragePath);
  response = await call(handleCoverage, 'POST', { date: DAY }, { check: {
    id: 'CK-EMPTY', asOf: DAY + 'T11:00:00', exceptions: [], presentKeys: []
  } });
  t('an identity-free check is denied rather than treated as global',
    response.code === 403 && raw(coveragePath) === before);
  const capped = json(coveragePath);
  capped.checks = new Array(24).fill(null).map((_, i) => ({
    id: 'CK-STL-' + i, asOf: DAY + 'T' + String(i).padStart(2, '0') + ':00:00',
    exceptions: [{ key: 'b:S1', badge: 'S1', location: stlPath }], presentKeys: []
  }));
  stored[coveragePath] = JSON.stringify(capped);
  before = raw(coveragePath);
  response = await call(handleCoverage, 'POST', { date: DAY }, { check: {
    id: 'CK-CHI-CAPPED', asOf: DAY + 'T23:30:00',
    exceptions: [{ key: 'b:C1', badge: 'C1', location: chiPath }], presentKeys: []
  } });
  t('a restricted append cannot evict another market at the daily cap',
    response.code === 409 && raw(coveragePath) === before);

  console.log('— restricted payroll GET/POST bypasses —');
  response = await call(handlePayroll, 'GET', { week: PAY_WEEK });
  const visiblePeriod = response.body.period;
  t('payroll GET returns only authorized rows and changes', response.code === 200 &&
    visiblePeriod.snapshots.length === 1 && visiblePeriod.snapshots[0].rows.length === 1 &&
    visiblePeriod.snapshots[0].rows[0].badge === 'C1' &&
    visiblePeriod.changes.length === 1 && visiblePeriod.changes[0].badge === 'C1');
  t('summary-only historical snapshots are omitted and the latest summary is recomputed',
    visiblePeriod.snapshots[0].summary.people === 1 &&
    visiblePeriod.snapshots[0].summary.totalHours === 40 &&
    visiblePeriod.snapshots[0].summary.touched === 1);
  t('restricted payroll GET exposes reviews only for visible changes',
    Object.keys(visiblePeriod.reviews).join(',') === chiReviewKey &&
    visiblePeriod.reviews[chiReviewKey].note === 'Chicago review');
  response = await call(handlePayroll, 'GET', {});
  t('payroll period index hides periods with no authorized records',
    response.body.periods.join(',') === PAY_WEEK);
  response = await call(handlePayroll, 'GET', { week: '2026-09-06' });
  t('direct payroll GET of another market returns no document metadata',
    response.code === 200 && Object.keys(response.body.period).length === 0);

  response = await call(handlePayroll, 'POST', { week: PAY_WEEK }, { review: {
    key: chiReviewKey, reviewed: true, note: 'Authorized Chicago decision', by: 'Forged client'
  } });
  t('restricted editor can update a matching visible in-market review',
    response.code === 200 && json(payrollPath).reviews[chiReviewKey].note === 'Authorized Chicago decision' &&
    json(payrollPath).reviews[chiReviewKey].by === 'Chicago Admin' &&
    json(payrollPath).reviews[chiReviewKey].byId === 'chi-admin@geodis.com');
  t('authorized review update preserves other market review partitions',
    json(payrollPath).reviews[stlReviewKey].note === 'St Louis review');

  before = raw(payrollPath);
  response = await call(handlePayroll, 'POST', { week: PAY_WEEK }, { review: {
    key: stlReviewKey, reviewed: true, note: 'Cross-market attempt'
  } });
  t('out-of-market review update is forbidden atomically',
    response.code === 403 && raw(payrollPath) === before);
  response = await call(handlePayroll, 'POST', { week: PAY_WEEK }, { review: {
    key: 'CHG-notfound', reviewed: true, note: 'Unknown-key attempt'
  } });
  t('unknown review key uses the same restricted denial with no mutation',
    response.code === 403 && raw(payrollPath) === before);

  before = raw(payrollPath);
  response = await call(handlePayroll, 'POST', { week: PAY_WEEK },
    { closesAt: '2026-09-02T17:00:00Z' });
  t('restricted user cannot change the global payroll close',
    response.code === 403 && raw(payrollPath) === before);
  response = await call(handlePayroll, 'POST', { week: PAY_WEEK },
    { rows: [{ badge: 'C1', hours: 99 }] });
  t('a bearer token cannot bypass the automation sync key',
    response.code === 401 && raw(payrollPath) === before);

  response = await call(handlePayroll, 'POST', { week: PAY_WEEK }, {
    rows: [{ badge: 'C1', hours: 41 }, { badge: 'S1', hours: 39 }],
    takenAt: '2026-09-02T09:00:00Z'
  }, { authorization: '', 'x-sync-key': KEY, origin: '' });
  t('trusted payroll automation still accepts the complete cross-market pull without a bearer token',
    response.code === 200 && json(payrollPath).snapshots.slice(-1)[0].rows.length === 2);
  t('trusted payroll automation preserves previously stored reviews',
    json(payrollPath).reviews[chiReviewKey].note === 'Authorized Chicago decision' &&
    json(payrollPath).reviews[stlReviewKey].note === 'St Louis review');

  console.log('— unrestricted compatibility —');
  auth.as({ email: 'global-admin@geodis.com', role: 'admin', enabled: true, markets: [] });
  response = await call(handleSchedule, 'GET', { period: WEEK });
  t('unrestricted schedule read retains all stored partitions',
    response.body.schedule.people.length === json(schedulePath).people.length);
  response = await call(handleCoverage, 'GET', { date: DAY });
  t('unrestricted coverage read retains every check and note',
    response.body.coverage.checks.length === json(coveragePath).checks.length &&
    Object.keys(response.body.coverage.documented).length === Object.keys(json(coveragePath).documented).length);
  response = await call(handlePayroll, 'POST', { week: PAY_WEEK },
    { closesAt: '2026-09-03T17:00:00Z' });
  t('unrestricted editor retains the global payroll-close contract',
    response.code === 200 && json(payrollPath).closesAt === '2026-09-03T17:00:00Z');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
