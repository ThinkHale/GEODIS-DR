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
const consts = src.slice(src.indexOf('const COLLECTIONS = {'), src.indexOf('const NOTES_ORIGIN'));
const helpers = src.slice(src.indexOf('async function readJsonArray'), src.indexOf('async function handleCollection'));
const handler = src.slice(src.indexOf('async function handlePlx('), src.indexOf('function parseToState'));

const NOTES_ORIGIN = 'https://geodis.ebtools.pro';
const KEY = 'k';
let files = {};
const bucket = { file: p2 => ({ save: async b => { files[p2] = b; } }) };
async function readJsonFile(p2) { try { return JSON.parse(files[p2]); } catch (e) { return {}; } }
function setKvCors() {}
const SYNC_KEY = { value: () => KEY };
let PLX_FLOW_URL = { value: () => '' };
let fetched = null;
const fetchStub = async (u, o) => { fetched = { u, o }; return { ok: true, status: 202 }; };

const built = new Function(
  'bucket', 'readJsonFile', 'setKvCors', 'SYNC_KEY', 'PLX_FLOW_URL',
  'NOTES_ORIGIN', 'XLSX', 'ShiftKey', 'Sched', 'fetch', 'console',
  consts + helpers + handler + '\nreturn {handlePlx, handlePlxRefresh, COLLECTIONS};'
)(bucket, readJsonFile, setKvCors, SYNC_KEY, { value: () => PLX_FLOW_URL.value() },
  NOTES_ORIGIN, XLSX, SK, Sched, fetchStub, console);
const { handlePlx, handlePlxRefresh, COLLECTIONS } = built;

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
  t('and the tags were not wiped', shifts().length === 1);

  console.log('— asking for a fresh pull —');
  r = await call(handlePlxRefresh, { method: 'POST', query: {}, get: () => 'https://evil.example' });
  t('a foreign origin is refused', r.code === 403);
  r = await call(handlePlxRefresh, { method: 'POST', query: {}, get: () => NOTES_ORIGIN });
  t('with no flow configured it still succeeds', r.code === 200);
  t('but says it did not trigger', r.body.triggered === false);
  t('and explains why', r.body.message.indexOf('PLX_FLOW_URL') !== -1);
  t('no call was made', fetched === null);

  PLX_FLOW_URL = { value: () => 'https://flow.example/run' };
  r = await call(handlePlxRefresh, { method: 'POST', query: {}, get: () => NOTES_ORIGIN });
  t('with a flow configured it triggers', r.body.triggered === true);
  t('calling the flow URL', fetched.u === 'https://flow.example/run');
  t('by POST', fetched.o.method === 'POST');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
