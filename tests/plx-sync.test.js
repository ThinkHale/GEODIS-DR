/* The live PLX workbook: parsing open orders, and the endpoint Power Automate
   pushes the workbook to. */
const fs = require('fs');
const path = require('path');
const SK = require('../shift-key.js');
const Sched = require('../schedule-core.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

console.log('— open orders on the Beeline Reqs tab —');
const reqAoa = [
  ['REQS BY BUILDINGS ', '', '', '', '', '', '', '', '', '', '', ''],
  ['Agency', 'Building ', 'Account Name ', 'Account ', 'Hire Date', 'Shift ', 'Job Type ', 'Req #', 'Quantity ', 'Report To', 'Job Function ', 'Notes'],
  ['PLX', '1500', 'Lindt ', '18086', '8/24/26', '1st ', 'OPR 1 ', '110150', '2', 'Byron Morales ', 'Reach/EPJ ', 'New Request'],
  ['PLX', '1502', 'CCM', '18845', '8/31/26', '2nd', 'OPR 2', '110426', '6', 'Marco Sotelo', 'Picker', ''],
  ['PLX', '1502', 'CCM', '18845', '8/31/26', '2nd', 'OPR 2', '110426', '3', 'Dup', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '']
];
let p = SK.parseRequisitions(reqAoa);
t('headers matched despite trailing spaces', p.rows.length === 2);
t('blank rows skipped', !p.rows.some(r => !r.reqNumber));
t('a duplicate req is reported', p.warnings.some(x => x.indexOf('110426') !== -1));
t('and only counted once', p.rows.filter(r => r.reqNumber === '110426').length === 1);
t('quantity read', p.rows[0].openings === 2);
t('building read', p.rows[0].building === '1500');
t('account read', p.rows[0].account === 'Lindt');
t('wrong tab is reported', SK.parseRequisitions([['a', 'b']]).warnings[0].indexOf('Req #') !== -1);

const recs = SK.toRequisitionRecords(p);
t('id from the req number', recs[0].id === 'REQ-110150');
t('title from job type', recs[0].title === 'OPR 1');
t('department from account', recs[0].department === 'Lindt');
t('due date from hire date', recs[0].due === '8/24/26');
t('source recorded', recs[0].source === 'PLX workbook');
t('filled is NOT produced -- the sheet does not track it', recs[0].filled === undefined);
t('nor is status', recs[0].status === undefined);

console.log('— against the real workbook, when present —');
const book = path.join(__dirname, '..', 'PLX - Geodis Spreadsheet.xlsx');
if (!fs.existsSync(book)) {
  console.log('  skipped - workbook not in the repo');
} else {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(book);
  const sheet = wb.SheetNames.filter(n => SK.REQ_SHEET.test(n))[0];
  t('the Beeline Reqs tab is found by pattern', !!sheet);
  const real = SK.parseRequisitions(XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: false, defval: '' }));
  t('20 open orders', real.rows.length === 20);
  t('78 openings in total', SK.toRequisitionRecords(real).reduce((n, r) => n + r.openings, 0) === 78);
  t('every one has an id', SK.toRequisitionRecords(real).every(r => r.id.indexOf('REQ-') === 0));
  t('no duplicate ids', new Set(SK.toRequisitionRecords(real).map(r => r.id)).size === 20);
}

/* ---------- the endpoint ---------- */
console.log('— the push endpoint —');
const XLSX = require('xlsx');
const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
/* The browser-facing halves of these handlers sit behind requireUser() now.
   The definition lives outside the slice each harness pulls, so the shared
   stub is injected -- same shape, same status codes. See fn-auth.js. */
const { makeAuth, reqGet } = require('./fn-auth.js');
const auth = makeAuth();
const consts = src.slice(src.indexOf('const COLLECTIONS = {'), src.indexOf('const NOTES_ORIGIN'));
const helpers = src.slice(src.indexOf('async function readJsonArray'), src.indexOf('async function handleCollection'));
// Start at the shared worker: handlePlx and the browser upload both call it, so
// slicing from handlePlx alone leaves applyPlxWorkbook undefined.
/* Sliced up to the auth section, not to the end of the file: past this point
   the source defines the REAL requireUser, which would shadow the injected stub
   and then need the Admin SDK and the whole COLLECTIONS map to run. The real
   one is exercised by collections.test.js, which pulls it in on purpose. */
const handler = src.slice(src.indexOf('async function applyPlxWorkbook('), src.indexOf('/* ---------- who is calling ----------'));

const NOTES_ORIGIN = 'https://geodis.ebtools.pro';
const KEY = 'k';
let files = {};
const bucket = { file: p2 => ({ save: async b => { files[p2] = b; } }) };
async function readJsonFile(p2) { try { return JSON.parse(files[p2]); } catch (e) { return {}; } }
function setKvCors() {}
const SYNC_KEY = { value: () => KEY };
let flowUrl = '';
let fetched = null;
const fetchStub = async (u, o) => { fetched = { u, o }; return { ok: true, status: 202 }; };

// The browser upload also runs the attendance import, which has its own suite;
// here it only has to exist so the module evaluates.
const Intake = require('../form-intake.js');
const AttendanceImport = require('../functions/attendance-import.js');
const rosterProfiles = async () => [];
const Contacts = require('../contacts-core.js');

const built = new Function(
  'bucket', 'readJsonFile', 'setKvCors', 'SYNC_KEY',
  'NOTES_ORIGIN', 'XLSX', 'ShiftKey', 'Sched', 'Intake', 'AttendanceImport',
  'Contacts', 'rosterProfiles', 'fetch', 'console', 'requireUser',
  consts + helpers + handler + '\nreturn {handlePlx, handlePlxUpload, handlePlxRefresh, COLLECTIONS};'
)(bucket, readJsonFile, setKvCors, SYNC_KEY,
  NOTES_ORIGIN, XLSX, SK, Sched, Intake, AttendanceImport, Contacts, rosterProfiles, fetchStub, console, auth.requireUser);
const { handlePlx, handlePlxUpload, handlePlxRefresh, COLLECTIONS } = built;

const mkRes = () => { const r = { code: null, body: null, set() { return r }, status(c) { r.code = c; return r }, json(b) { r.body = b; return r }, send() { return r } }; return r; };
const call = async (h, req) => { const res = mkRes(); await h(req, res); return res; };

// A miniature workbook with the three tabs that matter.
function makeBook() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['', '', '', '', '', '', '', 'Building', 'Job Title', 'Account Name', 'Account Num', 'Beeline Shift', 'Shift', 'Schedule', 'Rate', 'Supervisor'],
    ['', '', '', '', '', '', '', '1502', 'OPR2', 'CCM', '18845', '1', '1st', '6am-2:30pm Mon-Fri', '$19', 'P']
  ]), 'Geodis Key');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['PLX - 1ST SHIFT HEADCOUNT'],
    ['Transition', 'Dept', 'Employee  Name', 'EID', 'Start Date', 'Shift ', 'Current Points', 'Comments'],
    ['', '1502-18845', 'Grachen, Luz', '80-LGRACH3897', '5/28/26', '1st', '2', '']
  ]), '1502 - HC');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(reqAoa), '2026 - Beeline Reqs');
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}
const push = (body, key) => call(handlePlx, {
  method: 'POST', body, query: {}, get: h => (h === 'x-sync-key' ? (key === undefined ? KEY : key) : '')
});
const reqs = () => { try { return JSON.parse(files[COLLECTIONS.requisitions.path]); } catch (e) { return []; } };
const shifts = () => { try { return JSON.parse(files[COLLECTIONS.shifts.path]); } catch (e) { return []; } };

(async () => {
  t('no sync key rejected', (await push({ fileBase64: 'x' }, '')).code === 401);
  t('nothing written', Object.keys(files).length === 0);
  t('missing file rejected', (await push({})).code === 400);
  t('unreadable file rejected', (await push({ fileBase64: 'bm90IGEgd29ya2Jvb2s=' })).code === 400);

  let r = await push({ fileBase64: makeBook(), fileName: 'PLX.xlsx', modifiedAt: '2026-08-26T08:00:00Z' });
  t('accepted', r.code === 200);
  t('shift tags extracted', r.body.sync.shiftTags === 1);
  t('sites counted', r.body.sync.sites === 1);
  t('open orders extracted', r.body.sync.openOrders === 2);
  t('the file name is recorded', r.body.sync.fileName === 'PLX.xlsx');
  t('and when it was synced', !!r.body.sync.syncedAt);
  t('shift tags stored', shifts().length === 1);
  t('with the EID', shifts()[0].eid === '80-LGRACH3897');
  t('open orders stored', reqs().length === 2);
  t('with status set', reqs()[0].status === 'Open');

  console.log('— a refresh must not wipe what a person filled in —');
  let list = reqs();
  list[0].filled = 2; list[0].status = 'Filled'; list[0].priority = 'High';
  files[COLLECTIONS.requisitions.path] = JSON.stringify(list);
  await push({ fileBase64: makeBook() });
  const after = reqs().find(x => x.id === 'REQ-110150');
  t('filled survives the refresh', after.filled === 2);
  t('status survives', after.status === 'Filled');
  t('priority survives', after.priority === 'High');
  t('but the sheet still updates openings', after.openings === 2);
  t('no duplicates from re-pushing', reqs().length === 2);

  console.log('— a scheduled push must not erase a shift set by hand —');
  let sh = shifts();
  const UMA = Sched.rosterKey('Uma Untagged');
  sh.push({ id: 'name:' + UMA, nameKey: UMA, name: 'Uma Untagged', shift: '2nd', source: 'Set in the suite' });
  files[COLLECTIONS.shifts.path] = JSON.stringify(sh);
  await push({ fileBase64: makeBook() });
  t('the hand-set tag survives the push',
    shifts().some(x => x.nameKey === UMA && x.shift === '2nd'));
  t('and it is still marked as hand-set',
    shifts().find(x => x.nameKey === UMA).source === 'Set in the suite');
  t('the workbook tags are still there', shifts().some(x => x.eid === '80-LGRACH3897'));
  t('no duplicate workbook records build up', shifts().filter(x => x.eid === '80-LGRACH3897').length === 1);

  // Now the workbook gains that person -- it is the system of record, and two
  // records for one name would poison each other.
  sh = shifts();
  const LUZ = Sched.rosterKey('Grachen, Luz');
  sh.push({ id: 'name:' + LUZ, nameKey: LUZ, name: 'Grachen, Luz', shift: '3rd', source: 'Set in the suite' });
  files[COLLECTIONS.shifts.path] = JSON.stringify(sh);
  r = await push({ fileBase64: makeBook() });
  t('the workbook wins for someone it now covers',
    !shifts().some(x => x.source === 'Set in the suite' && x.nameKey === LUZ));
  t('leaving exactly one record for that name',
    shifts().filter(x => x.nameKey === LUZ).length === 1);
  t('and the override is reported, not silent',
    r.body.sync.warnings.some(x => x.indexOf('set by hand') !== -1));
  t('the unrelated hand-set tag is untouched',
    shifts().some(x => x.nameKey === UMA));

  console.log('— a req that left the sheet is closed, not deleted —');
  const shrunk = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(shrunk, XLSX.utils.aoa_to_sheet([reqAoa[0], reqAoa[1], reqAoa[2]]), '2026 - Beeline Reqs');
  await push({ fileBase64: XLSX.write(shrunk, { type: 'base64', bookType: 'xlsx' }) });
  t('both records still there', reqs().length === 2);
  const gone = reqs().find(x => x.id === 'REQ-110426');
  t('the departed one is marked Closed', gone.status === 'Closed');
  t('rather than removed', !!gone.id);
  t('a workbook with no HC tabs says so, and keeps the old tags',
    (await push({ fileBase64: XLSX.write(shrunk, { type: 'base64', bookType: 'xlsx' }) }))
      .body.sync.warnings.some(x => x.indexOf('HC') !== -1));
  t('and the workbook tag was not wiped', shifts().some(x => x.eid === '80-LGRACH3897'));

  console.log('— the same workbook, uploaded from the browser —');
  files = {};
  const upload = (body, origin, token) => call(handlePlxUpload, {
    method: 'POST', query: {}, body,
    get: reqGet({
      origin: origin === undefined ? NOTES_ORIGIN : origin,
      authorization: token === undefined ? 'Bearer test-token' : token
    })
  });
  t('a foreign origin is refused', (await upload({ fileBase64: makeBook() }, 'https://evil.example')).code === 403);
  t('and nothing is written', Object.keys(files).length === 0);
  /* An upload replaces every shift tag and every open order the site works
     from, so it is not something a read-only account gets to do by finding the
     endpoint. */
  t('an unsigned upload is refused', (await upload({ fileBase64: makeBook() }, undefined, '')).code === 401);
  t('and still nothing is written', Object.keys(files).length === 0);
  auth.as({ email: 'ro@geodis.com', role: 'viewer', enabled: true });
  t('so is one from an account that cannot import',
    (await upload({ fileBase64: makeBook() })).code === 403);
  auth.as({ email: 'col@geodis.com', role: 'colleague', enabled: true });
  t('no sync key needed -- this IS the browser, signed in',
    (await upload({ fileBase64: makeBook(), fileName: 'PLX.xlsx' })).code === 200);
  t('shift tags land the same as a push', shifts().length === 1);
  t('so do open orders', reqs().length === 2);
  t('the uploader is recorded',
    (await upload({ fileBase64: makeBook(), fileName: 'PLX.xlsx', uploadedBy: 'Cody Hale' })).body.sync.uploadedBy === 'Cody Hale');
  t('the wrong file is refused here too', (await upload({ fileBase64: 'bm90IGEgd29ya2Jvb2s=' })).code === 400);
  t('a missing file is refused', (await upload({})).code === 400);
  t('without a roster, attendance is skipped rather than failed',
    (await upload({ fileBase64: makeBook() })).body.attendance.skipped !== undefined);

  console.log('— asking for a fresh pull —');
  const refresh = (origin, token) => call(handlePlxRefresh, { method: 'POST', query: {},
    get: reqGet({ origin: origin === undefined ? NOTES_ORIGIN : origin,
      authorization: token === undefined ? 'Bearer test-token' : token }) });
  r = await refresh('https://evil.example');
  t('a foreign origin is refused', r.code === 403);
  // The flow reads SharePoint and rewrites the site's shift tags. Signed in only.
  t('and so is an unsigned caller', (await refresh(undefined, '')).code === 401);
  r = await refresh();
  t('with no flow configured it still succeeds', r.code === 200);
  t('but says it did not trigger', r.body.triggered === false);
  t('and explains how to enable it', r.body.message.indexOf('flowUrl') !== -1);
  t('no call was made', fetched === null);

  t('a non-https flow URL is refused',
    (await push({ flowUrl: 'http://insecure.example' })).code === 400);
  t('setting it needs the sync key', (await push({ flowUrl: 'https://flow.example/run' }, '')).code === 401);
  t('set from the automation side', (await push({ flowUrl: 'https://flow.example/run' })).body.configured === true);
  r = await refresh();
  t('with a flow configured it triggers', r.body.triggered === true);
  t('calling the flow URL', fetched.u === 'https://flow.example/run');
  t('by POST', fetched.o.method === 'POST');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
