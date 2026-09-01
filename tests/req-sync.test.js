/* The daily Beeline requisition exports, arriving by email.

   Two files land in one Outlook folder minutes apart, and a Power Automate flow
   POSTs each one as it comes. The endpoint has to work out WHICH export each
   file is from its columns, rebuild the board from both halves every time, and
   refuse anything that is not a requisition export without touching what is
   already stored. */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const Q = require('../reqs-core.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

/* Run the shipped source against a fake bucket, the way collections.test.js and
   plx-sync.test.js do, so this tests the deployed file rather than a copy. */
const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
const consts = src.slice(src.indexOf('const RAW_PATH = {'), src.indexOf('const NOTES_ORIGIN'));
const helpers = src.slice(src.indexOf('/* Power Automate represents a binary action output'), src.indexOf('/* ---------- shared, badge-keyed stores')) +
  src.slice(src.indexOf('async function readJsonFile('), src.indexOf('async function handleCollection('));
const handler = src.slice(src.indexOf('/* ---------- the daily Beeline requisition exports'),
  src.indexOf('async function handlePtoIntake('));

const KEY = 'k';
let files = {};
const bucket = {
  file: p => ({
    save: async b => { files[p] = b; },
    download: async () => {
      if (files[p] === undefined) { const e = new Error('not found'); e.code = 404; throw e; }
      return [Buffer.isBuffer(files[p]) ? files[p] : Buffer.from(String(files[p]))];
    }
  })
};
// The slice carries the real setKvCors, so it needs the origin it sets.
const NOTES_ORIGIN = 'https://geodis.ebtools.pro';
const SYNC_KEY = { value: () => KEY };

const built = new Function(
  'bucket', 'NOTES_ORIGIN', 'SYNC_KEY', 'XLSX', 'ReqsCore', 'Buffer', 'console',
  consts + '\n' + helpers + '\n' + handler + '\nreturn { handleReqSync, COLLECTIONS, REQ_META_PATH, REQ_RAW_PATH };'
)(bucket, NOTES_ORIGIN, SYNC_KEY, XLSX, Q, Buffer, console);
const { handleReqSync, COLLECTIONS, REQ_META_PATH } = built;

const mkRes = () => {
  const r = { code: null, body: null, set() { return r; }, status(c) { r.code = c; return r; },
    json(b) { r.body = b; return r; }, send() { return r; } };
  return r;
};
const call = async req => { const res = mkRes(); await handleReqSync(req, res); return res; };
const push = (aoa, fileName, key) => call({
  method: 'POST', query: {}, body: { fileBase64: book(aoa), fileName },
  get: h => (h === 'x-sync-key' ? (key === undefined ? KEY : key) : '')
});
const getSync = () => call({ method: 'GET', query: {}, get: () => '' });
const stored = p => { try { return JSON.parse(files[p]); } catch (e) { return null; } };
const reqs = () => stored(COLLECTIONS.requisitions.path) || [];
const cands = () => stored(COLLECTIONS.reqCandidates.path) || [];

function book(aoa) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}

// Shaped like the real exports: one row per (req x candidate).
const reqAoa = [
  ['Hiring Manager', 'Start Date - Start', 'Request-ID', 'Request Status', 'Candidates Requested',
   'Candidates Submitted', 'Candidates Declined', 'Candidates Offered', 'Candidates Hired',
   'Bill To Profit Center Name', 'Reports To'],
  ['Alva, Matthew', '04/27/2026', 'R-1', 'Open', '3', '2', '0', '1', '1', 'LLC;West;Seattle;4805-60176', 'Cotto, Millie'],
  ['Black, Daryl', '05/01/2026', 'R-2', 'Open', '2', '0', '0', '0', '0', 'LLC;South Central;St. Louis;1541-17543', '']
];
const candAoa = [
  ['Request-ID', 'Candidate', 'Job Position', 'Location Name', 'Internal Status', 'Beeline ID', 'External ID'],
  ['R-1', 'Isaiah Montoya', 'Warehouse - Operator 1', '4805 - 2202 Perimeter Rd,,Auburn,WA,US', 'Offer Confirmed', 'IMontoya0006', ''],
  ['R-1', 'Maria A Albarran', 'Warehouse - Operator 1', '4805 - 2202 Perimeter Rd,,Auburn,WA,US', 'Pending', 'MAlbarran6728', '21774830'],
  ['R-2', '', 'Warehouse - Material Handler', '1541 - 1 Main St,,St. Louis,MO,US', '', '', '']
];

(async () => {
  console.log('— the flow has to prove who it is —');
  t('no sync key is refused', (await push(reqAoa, 'reqs.xlsx', '')).code === 401);
  t('a wrong key is refused', (await push(reqAoa, 'reqs.xlsx', 'nope')).code === 401);
  t('and nothing was written', Object.keys(files).length === 0);

  console.log('— the morning reqs email —');
  let r = await push(reqAoa, 'GEODIS Open Reqs 09-01.xlsx');
  t('accepted', r.code === 200);
  /* The point of the whole endpoint: the file said what it was, nobody had to. */
  t('recognised as the reqs export by its columns, not its name', r.body.kind === 'reqs');
  t('the requests are stored', reqs().length === 2);
  t('keyed the same way the workbook sync keys them', reqs().every(x => /^REQ-/.test(x.id)));
  t('with the openings count', reqs().find(x => x.beelineReq === 'R-1').beelineOpenings === 3);
  t('and the market off the profit centre', reqs().find(x => x.beelineReq === 'R-1').market === 'Seattle');
  t('every record is stamped', reqs().every(x => !!x.updatedAt));

  /* Nothing waits for the second email. A board with openings on it is worth
     publishing at 6am rather than at 6:05. */
  t('it published without waiting for the candidate export', r.body.sync.reqs === 2);
  t('and says which columns are still missing', r.body.sync.missing.some(m => m.label === 'Candidate'));

  console.log('— the candidate email, minutes later —');
  r = await push(candAoa, 'Candidate Status per Req 09-01.xlsx');
  t('accepted', r.code === 200);
  t('recognised as the other export', r.body.kind === 'candidates');
  t('candidates are stored', cands().length === 2);
  t('attached to their request', cands().every(c => c.reqId === 'R-1'));
  t('a req row with no candidate name produces no candidate', !cands().some(c => !c.name));

  /* The half that arrived first must survive the second push -- it is read back
     out of storage, not lost because this email did not carry it. */
  t('the reqs half survived', reqs().length === 2);
  t('with its openings intact', reqs().find(x => x.beelineReq === 'R-1').beelineOpenings === 3);
  t('nothing is reported missing once both have landed', r.body.sync.missing.length === 0);
  t('both halves are named in the sync record',
    !!r.body.sync.sources.reqs && !!r.body.sync.sources.candidates);
  t('each with when it landed', !!r.body.sync.sources.reqs.receivedAt);
  t('and what was in it', r.body.sync.sources.candidates.candidates === 2);

  console.log('— reading the sync state back —');
  r = await getSync();
  t('GET needs no key, the way the tool reads it', r.code === 200);
  t('and returns the same record', r.body.sync.reqs === 2 && r.body.sync.candidates === 2);

  console.log('— a file that is not a requisition export —');
  const before = JSON.stringify(files);
  r = await push([['Employee', 'Hours'], ['Ava Reed', '40']], 'timesheet.xlsx');
  t('refused', r.code === 400);
  t('and says why', /Request-ID/i.test(r.body.error));
  t('it says the previous export is kept', /previous export/i.test(r.body.error));
  t('nothing was overwritten', JSON.stringify(files) === before);

  console.log('— a file with Request-IDs but neither export’s payload —');
  r = await push([['Request-ID', 'Request Status'], ['R-1', 'Open']], 'odd.xlsx');
  t('refused rather than filed under a guess', r.code === 400);
  t('and names what it did carry', Array.isArray(r.body.columnsFound) && r.body.columnsFound.indexOf('reqId') !== -1);
  t('still nothing overwritten', JSON.stringify(files) === before);

  console.log('— a mangled attachment —');
  r = await call({ method: 'POST', query: {}, body: { fileBase64: 'bm90IGEgd29ya2Jvb2s=', fileName: 'junk.xlsx' },
    get: h => (h === 'x-sync-key' ? KEY : '') });
  t('refused', r.code === 400);
  t('nothing overwritten', JSON.stringify(files) === before);

  /* Power Automate's "Get Attachment (V2)" hands back contentBytes that are
     base64 of base64. The reconciliation feed learned this years ago; the same
     connector feeds this endpoint. */
  console.log('— Power Automate double-encoding —');
  r = await call({ method: 'POST', query: {},
    body: { fileBase64: Buffer.from(book(reqAoa)).toString('base64'), fileName: 'double.xlsx' },
    get: h => (h === 'x-sync-key' ? KEY : '') });
  t('the extra layer is unwrapped, not rejected', r.code === 200);
  t('and it read as the reqs export', r.body.kind === 'reqs');

  /* The other shape the same connector produces. Whichever one a flow happens to
     send, the person building it should not have to find out which. */
  console.log('— and the $content envelope —');
  const envelope = Buffer.from(JSON.stringify({
    '$content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    $content: book(candAoa)
  })).toString('base64');
  r = await call({ method: 'POST', query: {}, body: { fileBase64: envelope, fileName: 'wrapped.xlsx' },
    get: h => (h === 'x-sync-key' ? KEY : '') });
  t('unwrapped too', r.code === 200);
  t('and read as the candidate export', r.body.kind === 'candidates');

  // The IL PTO flow posts under `file`; a req flow written the same way works.
  r = await call({ method: 'POST', query: {}, body: { file: book(reqAoa), fileName: 'alt-key.xlsx' },
    get: h => (h === 'x-sync-key' ? KEY : '') });
  t('either body key is accepted', r.code === 200);

  console.log('— a re-send replaces, it does not duplicate —');
  r = await push(reqAoa, 'GEODIS Open Reqs 09-01 (2).xlsx');
  t('still two requests, not four', reqs().length === 2);
  t('and still two candidates', cands().length === 2);
  t('the second copy of the file did not become a third source',
    Object.keys(r.body.sync.sources).length === 2);

  console.log('— today’s file outranks a half that stopped arriving —');
  /* buildBoard lets the first source win each field, so the order the halves are
     merged in decides whose answer survives. Yesterday's candidate export must
     not outvote this morning's reqs export. */
  const moved = reqAoa.map(row => row.slice());
  moved[1][1] = '05/15/2026';                       // the start date moved
  r = await push(moved, 'GEODIS Open Reqs 09-02.xlsx');
  t('the newer file wins the field both exports carry',
    reqs().find(x => x.beelineReq === 'R-1').startDate === '2026-05-15');

  console.log('— a request typed in by hand is left alone —');
  files[COLLECTIONS.requisitions.path] = JSON.stringify(reqs().concat([
    { id: 'RE123', title: 'Yard hostler', source: 'manual', openings: 1 }
  ]));
  r = await push(reqAoa, 'GEODIS Open Reqs 09-03.xlsx');
  t('it survives the import', reqs().some(x => x.id === 'RE123'));
  t('with its own fields untouched', reqs().find(x => x.id === 'RE123').title === 'Yard hostler');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
