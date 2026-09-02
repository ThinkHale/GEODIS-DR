/* Schedule + coverage persistence: the storage shapes (schedule-core.js) and the
   date-partitioned Cloud Function handlers (functions/index.js). */
const fs = require('fs');
const path = require('path');
const SC = require('../schedule-core.js');
const MarketAccess = require('../functions/market-access-core.js');

let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

/* ---------- fixtures ---------- */
const scheduleAoa = [
  ['Time Period :', '', '8/23/2026 - 8/29/2026'],
  ['Executed On :', '', '8/25/2026 7:02 AM'],
  ['GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523'],
  ['Employee', 'Primary Job', 'Sun', 'Mon', 'Tue'],
  ['', '', '8/23/2026', '8/24/2026', '8/25/2026'],
  ['Reed, Ava', 'Loader', '', '7:00 AM - 3:30 PM', '7:00 AM - 3:30 PM'],
  ['Ortiz, Ben', 'Picker', '', 'PTO', '9:30 PM - 6:00 AM'],
  ['Nash, Cleo', 'Clerk', '', '', '7:00 AM - 3:30 PM']
];
const onPremAoa = [
  ['Employee Full Name & ID', 'On Premises', 'Primary location', 'Reports To'],
  ['Reed, Ava (80-AREED1001)', 'true', 'GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523', 'Diaz, Mia'],
  ['Ortiz, Ben (80-BORTIZ1002)', 'false', 'GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523', 'Diaz, Mia'],
  ['Nash, Cleo (80-CNASH1003)', 'false', 'GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523', 'Diaz, Mia']
];
const schedule = SC.parseSchedule(scheduleAoa);
const presence = SC.parseOnPremise(onPremAoa);
// Roster keyed by badge, as buildProfiles() produces it.
const profiles = new Map([
  ['80-AREED1001', { badge: '80-AREED1001', name: 'Ava Reed', market: 'Atlanta' }],
  ['80-CNASH1003', { badge: '80-CNASH1003', name: 'Cleo Nash', market: 'Atlanta' }]
]);
const normBadge = v => String(v == null ? '' : v).trim();

console.log('— person keys —');
t('badge wins when resolved', SC.personKey({ badge: 'B1', wfmId: 'W1', nameKey: 'a,b' }) === 'b:B1');
t('falls back to WFM id', SC.personKey({ badge: '', wfmId: 'W1', nameKey: 'a,b' }) === 'w:W1');
t('falls back to name, in the cross-source form', SC.personKey({ badge: '', wfmId: '', name: 'Reed, Ava' }) === 'n:ava reed');
t('namespaces cannot collide', SC.personKey({ badge: 'X' }) !== SC.personKey({ wfmId: 'X' }));
t('profile offers both its keys', JSON.stringify(SC.profileKeys({ badge: 'B1', name: 'Ava Reed' })) === '["b:B1","n:ava reed"]');
// The roster says "Ava Reed", the WFM reports say "Reed, Ava". Both sides of the
// stored "n:" namespace must agree or a profile could never find its history.
t('roster and WFM name orders produce the same key',
  SC.personKey({ name: 'Reed, Ava' }) === SC.profileKeys({ badge: '', name: 'Ava Reed' })[0]);

console.log('— schedule for storage —');
const stored = SC.scheduleForStorage(schedule, { profiles, presence, normBadge, fileName: 'week.xlsx' });
t('period carried', stored.periodStart === '2026-08-23' && stored.periodEnd === '2026-08-29');
t('every scheduled person stored', stored.people.length === 3);
const ava = stored.people.find(p => p.nameKey === 'reed,ava');
t('badge resolved via on-premise bridge', ava.badge === '80-AREED1001');
t('WFM id captured from the bridge', ava.wfmId === '80-AREED1001');
t('shifts kept per date', ava.shifts['2026-08-25'].raw === '7:00 AM - 3:30 PM');
const ben = stored.people.find(p => p.nameKey === 'ortiz,ben');
t('unrostered person still stored', !!ben && ben.badge === '');
t('day codes survive storage', ben.shifts['2026-08-24'].code === 'PTO');
t('overnight flag survives', ben.shifts['2026-08-25'].overnight === true);
t('no roster still produces a document', SC.scheduleForStorage(schedule, {}).people.length === 3);

console.log('— a check: summary + exceptions + who was present —');
const asOf = new Date(2026, 7, 25, 11, 12, 0);   // Tue 25 Aug, 11:12 local
const res = SC.buildCoverage({ schedule, presence, asOf });
SC.linkRoster(res.rows, profiles, normBadge);
const check = SC.toCheck(res, { fileName: 'onprem_2026-08-25T11_12_00.csv' });
t('as-of stored in local time, not UTC', check.asOf === '2026-08-25T11:12:00');
t('id derives from as-of so a re-upload replaces', check.id === 'CK' + asOf.getTime());
t('summary kept', check.summary.onShift === 2);
t('Ava is working, so not an exception', !check.exceptions.some(e => e.name === 'Reed, Ava'));
t('Ava recorded as present', check.presentKeys.indexOf('b:80-AREED1001') !== -1);
const cleoEx = check.exceptions.find(e => e.name === 'Nash, Cleo');
t('Cleo is scheduled and absent -> exception', !!cleoEx && cleoEx.status === 'missing');
t('exception carries the shift', cleoEx.shift === '7:00 AM - 3:30 PM');
/* Every row, not only the ones that needed acting on -- that is what answers
   "who was on the floor at 11:12", which no exception list can. */
t('the whole report is carried too', check.rows.length === res.rows.length);
t('including somebody simply working', check.rows.some(r => r.name === 'Reed, Ava' && r.status === 'working'));
t('rows and exceptions are the same shape',
  Object.keys(check.rows[0]).sort().join() === Object.keys(check.exceptions[0]).sort().join());
t('the exceptions are still their own list, not derived on read',
  check.exceptions.length < check.rows.length);
t('exception carries the badge for follow-up', cleoEx.badge === '80-CNASH1003');
t('absent people are not in presentKeys', check.presentKeys.indexOf('b:80-CNASH1003') === -1);
t('Ben is on PTO, not an exception', !check.exceptions.some(e => e.name === 'Ortiz, Ben'));

console.log('— reading history back —');
const day = {
  date: '2026-08-25',
  checks: [
    { asOf: '2026-08-25T07:30:00', presentKeys: ['b:80-AREED1001'], exceptions: [{ key: 'b:80-CNASH1003', status: 'missing', shift: '7:00 AM - 3:30 PM' }] },
    { asOf: '2026-08-25T11:12:00', presentKeys: ['b:80-AREED1001', 'b:80-CNASH1003'], exceptions: [] }
  ],
  documented: { 'b:80-CNASH1003': { reason: 'Called in, car trouble', disposition: 'Called in' } }
};
const cleoKeys = SC.profileKeys({ badge: '80-CNASH1003', name: 'Cleo Nash' });
const hist = SC.presenceHistory(day, cleoKeys);
t('one entry per check', hist.length === 2);
t('absent at 7:30', hist[0].present === false && hist[0].status === 'missing');
t('present by 11:12', hist[1].present === true);
t('label resolved for the UI', hist[0].statusLabel === 'Not clocked in');
t('documentation found by badge key', SC.documentedFor(day, cleoKeys).disposition === 'Called in');
t('a key the day was not documented under misses', SC.documentedFor(day, ['n:cleo nash']) === null);
t('undocumented person returns null', SC.documentedFor(day, SC.profileKeys({ badge: 'ZZZ', name: 'No One' })) === null);
t('a person with no checks gets an empty history', SC.presenceHistory({ checks: [] }, cleoKeys).length === 0);
t('missing day document is safe', SC.presenceHistory(null, cleoKeys).length === 0);
t('schedule lookup by badge', SC.scheduleFor(stored, cleoKeys).name === 'Nash, Cleo');
t('schedule lookup by name when unrostered', SC.scheduleFor(stored, ['n:ben ortiz']).name === 'Ortiz, Ben');
t('unknown person has no schedule', SC.scheduleFor(stored, ['b:NOPE']) === null);

/* ---------- the Cloud Function handlers, run against a fake bucket ---------- */
console.log('— stored documents (functions/index.js) —');
const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
/* The browser-facing halves of these handlers sit behind requireUser() now.
   The definition lives outside the slice each harness pulls, so the shared
   stub is injected -- same shape, same status codes. See fn-auth.js. */
const { makeAuth, reqGet } = require('./fn-auth.js');
const auth = makeAuth();
const consts = src.slice(src.indexOf('const SCHEDULE_DIR'), src.indexOf('const NOTES_ORIGIN'));
/* Sliced up to the auth section, not to the end of the file: past this point
   the source defines the REAL requireUser, which would shadow the injected stub
   and then need the Admin SDK and the whole COLLECTIONS map to run. The real
   one is exercised by collections.test.js, which pulls it in on purpose. */
const handlers = src.slice(src.indexOf('function dateKeyOf'), src.indexOf('/* ---------- who is calling ----------'));

let files = {};
const bucket = {
  file: p => ({
    save: async body => { files[p] = body; },
    // Pruning aged-out reports deletes whole objects, so the fake has to be able
    // to. A missing file raises 404, the way Cloud Storage does.
    delete: async () => {
      if (!(p in files)) { const e = new Error('No such object'); e.code = 404; throw e; }
      delete files[p];
    }
  }),
  getFiles: async ({ prefix }) => [Object.keys(files).filter(k => k.startsWith(prefix)).map(name => ({ name }))]
};
const NOTES_ORIGIN = 'https://geodis.ebtools.pro';
async function readJsonFile(p) { return files[p] ? JSON.parse(files[p]) : {}; }
function setKvCors() {}
const { handleSchedule, handleCoverage, dateKeyOf } = new Function(
  'bucket', 'NOTES_ORIGIN', 'readJsonFile', 'setKvCors', 'console', 'requireUser', 'MarketAccess',
  consts + handlers + '\nreturn {handleSchedule,handleCoverage,dateKeyOf};'
)(bucket, NOTES_ORIGIN, readJsonFile, setKvCors, console, auth.requireUser, MarketAccess);

const mkRes = () => { const r = { code: null, body: null, set() { return r }, status(c) { r.code = c; return r }, json(b) { r.body = b; return r }, send() { return r } }; return r; };
/* `get` answers each header by name now. It used to answer every header with the
   origin, which was harmless until the handlers started reading a second one --
   an Authorization of "https://geodis.ebtools.pro" is not a token. */
const call = async (h, method, query, body, origin, token) => {
  const res = mkRes();
  const headers = {
    origin: origin === undefined ? NOTES_ORIGIN : origin,
    authorization: token === undefined ? 'Bearer test-token' : token
  };
  await h({ method, query: query || {}, body: body || {}, get: reqGet(headers) }, res);
  return res;
};

(async () => {
  console.log('  · date keys');
  t('valid ISO date accepted', dateKeyOf('2026-08-25') === '2026-08-25');
  t('path traversal refused', dateKeyOf('../../secrets') === '');
  t('slashes refused', dateKeyOf('2026/08/25') === '');
  t('partial date refused', dateKeyOf('2026-08') === '');
  t('empty refused', dateKeyOf('') === '' && dateKeyOf(null) === '');

  console.log('  · schedule document');
  let r = await call(handleSchedule, 'POST', { period: '2026-08-23' }, stored);
  t('week saved', r.code === 200 && r.body.people === 3);
  t('written to the partitioned path', !!files['schedule/weeks/2026-08-23.json']);
  r = await call(handleSchedule, 'GET', { period: '2026-08-23' });
  t('read back', r.body.schedule.people.length === 3);
  t('shifts survived the round trip', r.body.schedule.people[0].shifts['2026-08-25'].raw === '7:00 AM - 3:30 PM');
  r = await call(handleSchedule, 'GET', {});
  t('periods index lists the week', r.body.periods.indexOf('2026-08-23') !== -1);
  t('bad period refused', (await call(handleSchedule, 'POST', { period: 'evil/../x' }, stored)).code === 400);
  t('foreign origin refused', (await call(handleSchedule, 'POST', { period: '2026-08-23' }, stored, 'https://evil.example')).code === 403);
  t('missing people refused', (await call(handleSchedule, 'POST', { period: '2026-08-30' }, {})).code === 400);
  r = await call(handleSchedule, 'POST', { period: '2026-08-23' }, { people: [{ name: 'Solo', shifts: { 'bad-date': { raw: 'x' } } }] });
  t('re-upload replaces the week', JSON.parse(files['schedule/weeks/2026-08-23.json']).people.length === 1);
  t('malformed shift dates dropped', Object.keys(JSON.parse(files['schedule/weeks/2026-08-23.json']).people[0].shifts).length === 0);

  console.log('  · coverage document');
  r = await call(handleCoverage, 'POST', { date: '2026-08-25' }, { check });
  t('check appended', r.code === 200 && r.body.checks === 1);
  r = await call(handleCoverage, 'POST', { date: '2026-08-25' }, { check });
  t('same check id replaces, not duplicates', r.body.checks === 1);
  const later = Object.assign({}, check, { id: 'CK2', asOf: '2026-08-25T14:00:00' });
  r = await call(handleCoverage, 'POST', { date: '2026-08-25' }, { check: later });
  t('a second pull appends', r.body.checks === 2);
  t('checks ordered by as-of', JSON.parse(files['coverage/days/2026-08-25.json']).checks[0].asOf === '2026-08-25T11:12:00');

  console.log('  · documenting an absence');
  r = await call(handleCoverage, 'POST', { date: '2026-08-25' }, { document: { key: 'b:80-CNASH1003', name: 'Nash, Cleo', badge: '80-CNASH1003', reason: 'Called in, car trouble', disposition: 'Called in' } });
  t('documentation saved', r.code === 200);
  let doc = JSON.parse(files['coverage/days/2026-08-25.json']);
  t('stored against the person key', doc.documented['b:80-CNASH1003'].reason === 'Called in, car trouble');
  t('coverage documentation records the authenticated editor',
    doc.documented['b:80-CNASH1003'].updatedBy === 'Tester' &&
    doc.documented['b:80-CNASH1003'].updatedById === 'tester@geodis.com');
  t('documenting did not disturb the checks', doc.checks.length === 2);
  await call(handleCoverage, 'POST', { date: '2026-08-25' }, { check: later });
  t('a later check preserves documentation', JSON.parse(files['coverage/days/2026-08-25.json']).documented['b:80-CNASH1003'].disposition === 'Called in');
  await call(handleCoverage, 'POST', { date: '2026-08-25' }, { document: { key: 'b:80-CNASH1003', reason: '', disposition: '' } });
  t('clearing removes the entry', JSON.parse(files['coverage/days/2026-08-25.json']).documented['b:80-CNASH1003'] === undefined);
  t('document without a key refused', (await call(handleCoverage, 'POST', { date: '2026-08-25' }, { document: { reason: 'x' } })).code === 400);
  t('neither check nor document refused', (await call(handleCoverage, 'POST', { date: '2026-08-25' }, { junk: 1 })).code === 400);
  t('bad date refused', (await call(handleCoverage, 'POST', { date: '../x' }, { check })).code === 400);
  t('foreign origin refused', (await call(handleCoverage, 'POST', { date: '2026-08-25' }, { check }, 'https://evil.example')).code === 403);

  /* The bulky half of a check is stored apart from the day document and kept for
     a week. Two things have to hold, and they pull in opposite directions:
     the day document must stay light (it is rewritten every time somebody types
     a note), and the reader must not have to know any of that. */
  console.log('  · the full report, kept for a week');
  const dayKey = n => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const TODAY_K = dayKey(0), OLD_K = dayKey(-30);
  const fresh = Object.assign({}, check, { id: 'CKROWS', asOf: TODAY_K + 'T09:00:00' });

  r = await call(handleCoverage, 'POST', { date: TODAY_K }, { check: fresh });
  t('the day saved', r.code === 200);
  t('and reports how many rows it kept', r.body.rowsKept === check.rows.length);
  const rowFile = 'coverage/rows/' + TODAY_K + '.json';
  t('the full report went to its own object', !!files[rowFile]);
  t('keyed by the check it came from',
    JSON.parse(files[rowFile]).checks.CKROWS.length === check.rows.length);
  /* The day document is read-modify-written on every note somebody types. If the
     rows lived in it, every note would drag the whole report down and back. */
  const lightDoc = JSON.parse(files['coverage/days/' + TODAY_K + '.json']);
  t('and NOT into the day document', !lightDoc.checks.some(c => c.rows !== undefined));
  /* The point of keeping them apart: documenting an absence rewrites the day
     document, and must not drag the whole report down and back up with it. */
  const rowsBefore = files[rowFile];
  await call(handleCoverage, 'POST', { date: TODAY_K },
    { document: { key: 'b:80-CNASH1003', name: 'Nash, Cleo', badge: '80-CNASH1003', reason: 'Car trouble', disposition: 'Called in' } });
  t('a note is saved', !!JSON.parse(files['coverage/days/' + TODAY_K + '.json']).documented['b:80-CNASH1003']);
  t('and never touches the stored report', files[rowFile] === rowsBefore);

  r = await call(handleCoverage, 'GET', { date: TODAY_K });
  const readBack = r.body.coverage.checks.find(c => c.id === 'CKROWS');
  t('a reader gets them back on the check, as one shape',
    readBack.rows.length === check.rows.length);
  t('with the exceptions still alongside', readBack.exceptions.length === check.exceptions.length);
  t('and is told where the window starts', !!r.body.coverage.rowsRetainedFrom);

  // A backfill for a date already outside the window stores nothing it would
  // only have to delete on the next pass.
  r = await call(handleCoverage, 'POST', { date: OLD_K }, { check: Object.assign({}, check, { id: 'CKOLD' }) });
  t('a backfill past the window keeps no rows', r.body.rowsKept === 0);
  t('and writes no rows object at all', !files['coverage/rows/' + OLD_K + '.json']);
  t('while still storing the day itself', !!files['coverage/days/' + OLD_K + '.json']);

  // A report that has aged out is deleted outright on the next save.
  files['coverage/rows/' + OLD_K + '.json'] = JSON.stringify({ date: OLD_K, checks: { X: [{ key: 'b:1' }] } });
  files['coverage/days/' + OLD_K + '.json'] = files['coverage/days/' + OLD_K + '.json'] || '{}';
  await call(handleCoverage, 'POST', { date: TODAY_K }, { check: fresh });
  t('an aged-out report is dropped', !files['coverage/rows/' + OLD_K + '.json']);
  t('but its day -- exceptions and documentation -- is untouched',
    !!files['coverage/days/' + OLD_K + '.json']);
  t('and the current one is left alone', !!files[rowFile]);

  t('the browser and the server agree on the window',
    SC.ROW_RETENTION_DAYS === 7 &&
    /const ROW_RETENTION_DAYS = 7;/.test(src));

  console.log('  · reading a day back');
  r = await call(handleCoverage, 'GET', { date: '2026-08-25' });
  t('day read back', r.body.coverage.checks.length === 2);
  r = await call(handleCoverage, 'GET', {});
  t('dates index lists the day', r.body.dates.indexOf('2026-08-25') !== -1);
  r = await call(handleCoverage, 'GET', { date: '2026-01-01' });
  t('a day with nothing stored is empty, not an error', r.code === 200);

  console.log('  · caps');
  const many = { people: new Array(5001).fill({ name: 'x', shifts: {} }) };
  t('oversized schedule refused', (await call(handleSchedule, 'POST', { period: '2026-09-06' }, many)).code === 400);
  for (let i = 0; i < 30; i++) {
    await call(handleCoverage, 'POST', { date: '2026-09-01' }, { check: { id: 'C' + i, asOf: '2026-09-01T' + String(i % 24).padStart(2, '0') + ':00:00' } });
  }
  t('checks per day capped at 24', JSON.parse(files['coverage/days/2026-09-01.json']).checks.length === 24);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
