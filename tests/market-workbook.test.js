/* One workbook per market, and above all: nothing another market uploads may
   touch Chicago's. Chicago's PLX workbook is uploaded first, then a St. Louis
   workbook of the same shape; every Chicago store is compared before and after,
   byte for byte. */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const SK = require('../shift-key.js');
const H = require('../plx-history-core.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
const { makeAuth, reqGet } = require('./fn-auth.js');
const auth = makeAuth();
const consts = src.slice(src.indexOf('const COLLECTIONS = {'), src.indexOf('const NOTES_ORIGIN'));
const decoders = src.slice(src.indexOf('function looksLikeBase64('), src.indexOf('function normalizeUtf16('));
const helpers = src.slice(src.indexOf('async function readJsonArray'), src.indexOf('async function handleCollection'));
const handler = src.slice(src.indexOf('async function applyPlxWorkbook('), src.indexOf('/* ---------- who is calling ----------'));

const ORIGIN = 'https://geodis.ebtools.pro';
let files = {};
const bucket = { file: k => ({
  save: async b => { files[k] = Buffer.isBuffer(b) ? b : String(b); },
  download: async () => { if (!(k in files)) { const e = new Error('nope'); e.code = 404; throw e; } return [Buffer.from(files[k])]; },
  delete: async () => { delete files[k]; }
}) };
async function readJsonFile(k) { try { return JSON.parse(files[k]); } catch (e) { return {}; } }

const built = new Function(
  'bucket', 'readJsonFile', 'setKvCors', 'SYNC_KEY', 'NOTES_ORIGIN', 'XLSX', 'ShiftKey', 'Sched', 'Intake',
  'AttendanceImport', 'Contacts', 'rosterProfiles', 'fetch', 'console', 'requireUser',
  'PlxHistory', 'crypto', 'MarketAccess', 'Auth', 'SNAPSHOT_PATH', 'ReqsCore',
  consts + decoders + helpers + handler + '\nreturn {handlePlx, handlePlxUpload, handlePlxChanges, COLLECTIONS, plxPaths};'
)(bucket, readJsonFile, () => {}, { value: () => 'k' }, ORIGIN, XLSX, SK,
  require('../schedule-core.js'), require('../form-intake.js'), require('../functions/attendance-import.js'),
  require('../contacts-core.js'), async () => [], async () => ({ ok: true }), console, auth.requireUser,
  H, require('crypto'), require('../market-access-core.js'), auth.Auth, 'snapshots/latest.json', require('../reqs-core.js'));
const { handlePlx, handlePlxUpload, handlePlxChanges, COLLECTIONS, plxPaths } = built;

const mkRes = () => { const r = { code: null, body: null, set() { return r; }, status(c) { r.code = c; return r; }, json(x) { r.body = x; return r; }, send() { return r; } }; return r; };
const call = async (h, req) => { const res = mkRes(); await h(req, res); return res; };

/* A workbook for some sites. people: [[site, name, eid, shift]], reqs: [[site, req, qty]] */
function book(people, reqs) {
  const wb = XLSX.utils.book_new();
  const sites = Array.from(new Set(people.map(p => p[0]).concat(reqs.map(r => r[0]))));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['', '', '', '', '', '', '', 'Building', 'Job Title', 'Account Name', 'Account Num', 'Beeline Shift', 'Shift', 'Schedule'],
    ...sites.map(s => ['', '', '', '', '', '', '', s, 'OPR1', 'ACME ' + s, '1' + s, '1', '1st', '6am-2:30pm Mon-Fri'])
  ]), 'Geodis Key');
  sites.forEach(site => {
    const rows = people.filter(p => p[0] === site);
    if (!rows.length) return;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['PLX - 1ST SHIFT HEADCOUNT'],
      ['Transition', 'Dept', 'Employee  Name', 'EID', 'Start Date', 'Shift ', 'Current Points', 'Comments'],
      ...rows.map(p => ['', site + '-1' + site, p[1], p[2], '9/1/26', p[3], '0', ''])
    ]), site + ' - HC');
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['REQS BY BUILDINGS'],
    ['Agency', 'Building ', 'Account Name ', 'Account ', 'Hire Date', 'Shift ', 'Job Type ', 'Req #', 'Quantity ', 'Report To', 'Job Function ', 'Notes'],
    ...reqs.map(r => ['PLX', r[0], 'ACME ' + r[0], '1' + r[0], '10/5/26', '1st', 'OPR 1', r[1], String(r[2]), 'Boss', 'Reach', ''])
  ]), '2026 - Beeline Reqs');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['LIST OF OPENINGS'],
    ['Building ', 'Agency', 'Account', '(Last Name, First Name)', 'Position', 'Shift', 'Start Date', 'WT Date & Time', 'Job Function '],
    ...sites.map(s => [s, 'PLX', 'ACME ' + s, '', 'Operator', '1st', '', '', 'Reach'])
  ]), 'Chicago WT List');
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}
const CHI = book([['1500', 'Chi, Ann', '80-ACHI0001', '1st'], ['1502', 'Chi, Bob', '80-BCHI0002', '2nd']],
  [['1500', '200100', 3], ['1502', '200200', 2]]);
const STL = book([['1523', 'Lou, Sam', '80-SLOU0003', '1st'], ['1541', 'Lou, Tia', '80-TLOU0004', '1st']],
  [['1523', '300100', 4], ['1541', '300200', 1]]);
const STL2 = book([['1523', 'Lou, Sam', '80-SLOU0003', '1st']], [['1523', '300100', 6]]);   // Tia and 300200 gone

const push = (b64, market) => call(handlePlx, { method: 'POST', query: {}, body: { fileBase64: b64, market },
  get: h => (h === 'x-sync-key' ? 'k' : '') });
const upload = (b64, market) => call(handlePlxUpload, { method: 'POST', query: {},
  body: { fileBase64: b64, fileName: 'book.xlsx', market, uploadedBy: 'Tester' },
  get: reqGet(Object.assign({ origin: ORIGIN }, auth.headers)) });
const get = (h, query) => call(h, { method: 'GET', query, get: reqGet(auth.headers) });
const json = k => { try { return JSON.parse(files[k]); } catch (e) { return null; } };
const shifts = () => json(COLLECTIONS.shifts.path) || [];
const reqs = () => json(COLLECTIONS.requisitions.path) || [];
// Everything Chicago owns, as stored text, for byte-for-byte comparison.
const chicagoState = () => JSON.stringify({
  shifts: shifts().filter(r => !r.workbookMarket),
  reqs: reqs().filter(r => !r.workbookMarket),
  meta: files['plx/sync.json'], index: files['plx/history/index.json'], series: files['plx/headcount-series.json'],
  historyFiles: Object.keys(files).filter(k => k.indexOf('plx/history/') === 0).sort()
});

(async () => {
  files[COLLECTIONS.locations.path] = JSON.stringify([
    { id: 'LOC-1523', code: '1523', market: 'St. Louis' }, { id: 'LOC-1532', code: '1532', market: 'St. Louis' },
    { id: 'LOC-1541', code: '1541', market: 'St. Louis' }, { id: 'LOC-1554', code: '1554', market: 'St. Louis' }
    // Chicago's sites are deliberately NOT listed: its uploads must work as they always have.
  ]);

  console.log('— Chicago, exactly as before —');
  let r = await push(CHI);
  t('a push with no market is Chicago\'s, and works with its sites unlisted', r.code === 200 && r.body.sync.market === 'Chicago');
  t('Chicago shift tags carry no market tag -- the same records as always', shifts().length === 2 &&
    shifts().every(x => x.source === 'PLX workbook' && !('workbookMarket' in x)));
  t('nor do its orders', reqs().length === 2 && reqs().every(x => !('workbookMarket' in x)));
  t('its sync record is where it always was', !!files['plx/sync.json']);
  t('and its history', json('plx/history/index.json').entries.length === 1);
  // A tag somebody set by hand in the suite.
  const hand = shifts().concat([{ id: 'name:hand', nameKey: 'hand set', name: 'Set, Hand', shift: '2nd', source: 'Set in the suite' }]);
  files[COLLECTIONS.shifts.path] = JSON.stringify(hand);
  // And a Chicago order somebody filled in.
  const filled = reqs().map(x => x.id === 'REQ-200100' ? Object.assign({}, x, { filled: 1, priority: 'High' }) : x);
  files[COLLECTIONS.requisitions.path] = JSON.stringify(filled);
  const before = chicagoState();

  console.log('— St. Louis uploads its own workbook —');
  r = await push(STL, 'St. Louis');
  t('accepted', r.code === 200 && r.body.sync.market === 'St. Louis');
  t('its shift tags are its own', shifts().filter(x => x.workbookMarket === 'St. Louis').length === 2);
  t('its orders are its own', reqs().filter(x => x.workbookMarket === 'St. Louis').length === 2);
  t('EVERY CHICAGO STORE IS UNCHANGED', chicagoState() === before);
  t('the hand-set tag survives', shifts().some(x => x.source === 'Set in the suite'));
  t('no Chicago order was closed', reqs().filter(x => !x.workbookMarket).every(x => x.status !== 'Closed'));
  t('what somebody filled in on a Chicago order survives', reqs().find(x => x.id === 'REQ-200100').filled === 1);
  t('St. Louis keeps its own sync record', JSON.parse(files['plx/markets/st-louis/sync.json']).fileName !== undefined);
  t('and its own history', json('plx/markets/st-louis/history/index.json').entries.length === 1);
  t('and is remembered as a market with a workbook', json('plx/markets.json').markets.join() === 'St. Louis');

  console.log('— St. Louis re-uploads: only its own records move —');
  r = await push(STL2, 'St. Louis');
  t('a St. Louis tag that left its sheet is gone', !shifts().some(x => x.eid === '80-TLOU0004'));
  t('a St. Louis order that left its sheet is closed', reqs().find(x => x.id === 'REQ-300200').status === 'Closed');
  t('St. Louis changes are compared with St. Louis only', r.body.sync.changes && r.body.sync.changes.ended === 1 &&
    r.body.sync.changes.started === 0);
  t('EVERY CHICAGO STORE IS STILL UNCHANGED', chicagoState() === before);

  console.log('— Chicago re-uploads: St. Louis is left alone —');
  const CHI2 = book([['1500', 'Chi, Ann', '80-ACHI0001', '1st']], [['1500', '200100', 3]]);
  r = await push(CHI2);
  t('Chicago still replaces its own tags', !shifts().some(x => x.eid === '80-BCHI0002'));
  t('and closes its own order that left the sheet', reqs().find(x => x.id === 'REQ-200200').status === 'Closed');
  t('St. Louis tags untouched', shifts().filter(x => x.workbookMarket === 'St. Louis').map(x => x.eid).join() === '80-SLOU0003');
  t('St. Louis orders untouched', reqs().find(x => x.id === 'REQ-300100').status !== 'Closed' &&
    reqs().find(x => x.id === 'REQ-300100').openings === 6);
  t('Chicago is compared with Chicago only', r.body.sync.changes.ended === 1 && r.body.sync.changes.started === 0);

  console.log('— the wrong workbook for the market is refused, and changes nothing —');
  const snapshotAll = JSON.stringify(files);
  r = await push(STL, 'Chicago');
  t('St. Louis\'s file as Chicago\'s', r.code === 400 && /not Chicago's/.test(r.body.error) && /St\. Louis/.test(r.body.error));
  r = await push(STL);
  t('also with no market given', r.code === 400);
  r = await push(CHI, 'St. Louis');
  t('Chicago\'s file as St. Louis\'s (its sites are not listed there)', r.code === 400 && /St\. Louis/.test(r.body.error));
  t('nothing was written by any of them', JSON.stringify(files) === snapshotAll);

  console.log('— the browser upload —');
  auth.as({ markets: ['Chicago'], role: 'colleague' });
  r = await upload(STL2, 'St. Louis');
  t('an account that does not cover St. Louis cannot upload its workbook', r.code === 403);
  auth.as({ markets: ['IL Campus'], role: 'colleague' });
  r = await upload(CHI2);
  t('Chicago uploads are not newly blocked by how an account spells its market', r.code === 200);
  auth.as({ markets: ['St. Louis'], role: 'colleague' });
  r = await upload(STL2, 'St. Louis');
  t('a St. Louis account can', r.code === 200 && r.body.sync.market === 'St. Louis');
  auth.as({});

  console.log('— reading it back —');
  r = await get(handlePlx, { plx: '1' });
  t('no market reads Chicago\'s sync, as before', r.body.sync.market === 'Chicago' && !/st/i.test(r.body.sync.fileName || ''));
  r = await get(handlePlx, { plx: '1', market: 'St. Louis' });
  t('St. Louis reads its own', r.body.sync.market === 'St. Louis' && r.body.sync.uploadedBy === 'Tester');
  r = await get(handlePlxChanges, { plxChanges: '1' });
  t('Meeting Prep with no market is Chicago\'s', r.body.market === 'Chicago' &&
    r.body.profile.sites.every(x => ['1500', '1502'].indexOf(x.location) !== -1));
  r = await get(handlePlxChanges, { plxChanges: '1', market: 'St. Louis' });
  t('St. Louis\'s is its own', r.body.profile.sites.every(x => ['1523', '1541'].indexOf(x.location) !== -1) &&
    r.body.uploads.every(u => u.market === 'St. Louis'));
  r = await get(handlePlxChanges, { plxChanges: '1', market: 'all' });
  t('All markets combines both', r.body.markets.join() === 'Chicago,St. Louis' &&
    r.body.profile.sites.some(x => x.location === '1500') && r.body.profile.sites.some(x => x.location === '1523'));
  t('and each was compared only with itself', r.body.comparison.changes.counts.started === 0);
  t('the upload lists join', r.body.uploads.some(u => u.market === 'Chicago') && r.body.uploads.some(u => u.market === 'St. Louis'));
  const stlId = r.body.uploads.filter(u => u.market === 'St. Louis')[0].id;
  r = await get(handlePlxChanges, { plxChanges: '1', download: stlId });
  t('a St. Louis upload can be downloaded', r.code === 200 && !!r.body.fileBase64);
  r = await get(handlePlxChanges, { plxChanges: '1', from: stlId });
  t('a St. Louis upload is not one of Chicago\'s', r.code === 404);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})().catch(err => { console.error(err); process.exit(1); });
