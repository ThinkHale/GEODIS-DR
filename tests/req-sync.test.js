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
/* The browser-facing halves of these handlers sit behind requireUser() now.
   The definition lives outside the slice each harness pulls, so the shared
   stub is injected -- same shape, same status codes. See fn-auth.js. */
const { makeAuth, reqGet } = require('./fn-auth.js');
const auth = makeAuth();
/* A refused post is logged now, so "the flow never ran" and "the flow ran and
   was turned away" stop looking identical. The console is captured to prove the
   message says which, and never carries the secret itself. */
const warnings = [];
const cap = Object.assign({}, console, { warn: (...a) => warnings.push(a.join(' ')) });
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
  'bucket', 'NOTES_ORIGIN', 'SYNC_KEY', 'XLSX', 'ReqsCore', 'Buffer', 'console', 'requireUser',
  consts + '\n' + helpers + '\n' + handler + '\nreturn { handleReqSync, COLLECTIONS, REQ_META_PATH, REQ_RAW_PATH };'
)(bucket, NOTES_ORIGIN, SYNC_KEY, XLSX, Q, Buffer, cap, auth.requireUser);
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
const getSync = (token) => call({ method: 'GET', query: {},
  get: reqGet({ authorization: token === undefined ? 'Bearer test-token' : token }) });
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
  warnings.length = 0;
  t('no sync key is refused', (await push(reqAoa, 'reqs.xlsx', '')).code === 401);
  /* Silence here is the failure that cost a morning: a flow posting with a stale
     key looked exactly like a flow that never ran. */
  t('and the refusal is logged, saying which feed', warnings.some(w => /Beeline requisition export/.test(w)));
  t('and why', warnings.some(w => /no x-sync-key header was sent/.test(w)));
  warnings.length = 0;
  t('a wrong key is refused too', (await push(reqAoa, 'reqs.xlsx', 'not-the-key')).code === 401);
  t('logged as a mismatch, not a missing header',
    warnings.some(w => /does not match/.test(w)));
  t('and the key that was offered never reaches the log',
    warnings.every(w => w.indexOf('not-the-key') === -1));
  t('only its length, which is what spots a truncated secret',
    warnings.some(w => /11 characters/.test(w)));
  warnings.length = 0;
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
  t('GET needs an account, not the sync key -- this is how the tool reads it', r.code === 200);
  t('and is refused with neither', (await getSync('')).code === 401);
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

  /* The reports actually arrive as .csv, not .xlsx -- quoted fields, CRLF line
     endings, and a trailing empty column where "Reports To" is blank. Pinned
     from a real 2026-09-01 attachment, because the flow's file-type filter was
     written for the wrong extension and nothing here caught it. */
  console.log('— the reports as they really arrive: CSV —');
  const realCsv =
    '"Hiring Manager","Start Date - Start","Request-ID","Request Status","Candidates Requested",' +
    '"Candidates Submitted","Candidates Declined","Candidates Offered","Candidates Hired",' +
    '"Bill To Profit Center Name","Reports To"\r\n' +
    '"Adams, Katherine","09/04/2026","110581-1","Open","5","0","0","0","0","LLC;North East;Central PA;3902-18067",\r\n' +
    '"Alva, Matthew","04/27/2026","105266-1","Open","2","1","0","1","1","LLC;West;Seattle;4805-60176",\r\n' +
    '"Cotto, Millie","07/17/2026","108015-1","Open","10","6","0","6","4","LLC;South East;Coastal;1029-18062","millie cotto"\r\n';
  files = {};
  r = await call({ method: 'POST', query: {},
    body: { fileBase64: Buffer.from(realCsv, 'utf8').toString('base64'),
            fileName: 'GEODIS Open Reqs09-01-2026.csv' },
    get: h => (h === 'x-sync-key' ? KEY : '') });
  t('a CSV export is accepted', r.code === 200);
  t('and still recognised by its columns', r.body.kind === 'reqs');
  t('quoted fields parsed', reqs().length === 3);
  t('the counts survive the quoting',
    reqs().find(x => x.beelineReq === '105266-1').beelineOpenings === 2);
  t('the date normalises', reqs().find(x => x.beelineReq === '105266-1').startDate === '2026-04-27');
  t('the market comes off the profit centre',
    reqs().find(x => x.beelineReq === '105266-1').market === 'Seattle');
  t('a trailing empty column is not a parse failure',
    reqs().find(x => x.beelineReq === '110581-1').supervisor === '');
  t('and a row that does fill it keeps the value',
    reqs().find(x => x.beelineReq === '108015-1').supervisor === 'millie cotto');

  /* CSV text is not base64-shaped, so the double-base64 unwrap has to leave it
     alone rather than trying to decode it a second time. */
  t('the unwrap did not mangle it', r.body.sync.sources.reqs.rowCount === 3);

  console.log('— a re-send replaces, it does not duplicate —');
  files = {};
  await push(reqAoa, 'GEODIS Open Reqs 09-01.xlsx');
  await push(candAoa, 'Candidate Status per Req 09-01.xlsx');
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

  /* Power Automate's Get Attachment (V2) double-base64-encodes contentBytes.
     The unwrap that rescues that used to accept ONLY an xlsx zip -- so when
     these exports changed from .xlsx to .csv it quietly stopped firing, the
     parser was handed one line of base64 text, and every report failed at once
     with "No Request-ID column was found": a message that pointed at the
     columns when the columns were never the problem. */
  console.log('— every shape the attachment arrives in —');
  const csvText = 'Request-ID,Job Title,Candidates Requested\nREQ-7001,Picker,4\nREQ-7002,Loader,2';
  const enc = t => Buffer.from(t, 'utf8').toString('base64');
  const pushRaw = (b64, name) => call({
    method: 'POST', query: {}, body: { fileBase64: b64, fileName: name },
    get: reqGet({ 'x-sync-key': KEY })
  });
  t('a single-encoded CSV is read', (await pushRaw(enc(csvText), 'reqs.csv')).code === 200);
  t('and a DOUBLE-encoded one is too', (await pushRaw(enc(enc(csvText)), 'reqs.csv')).code === 200);
  t('with the same requests either way', reqs().some(r => r.beelineReq === 'REQ-7001'));
  t('a single-encoded xlsx still works', (await push(reqAoa, 'reqs.xlsx')).code === 200);
  /* Erring toward unwrapping is safe: a wrong guess produces a 400 and the
     previous export is kept. Erring the other way is what cost a morning. */
  const junk = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]).toString('base64');
  t('binary that is neither is refused, not guessed at', (await pushRaw(junk, 'x.bin')).code === 400);

  /* The refusal has to say what it actually saw. "No Request-ID column" alone
     cannot tell a renamed column from an empty file from the wrong attachment. */
  console.log('— and a refusal says what it saw —');
  const renamed = await pushRaw(enc('Order ID,Job Title\nA1,Picker'), 'reqs.csv');
  t('a renamed column is refused', renamed.code === 400);
  t('and the headers it DID find are named', /"Order ID"/.test(renamed.body.error));
  t('with the row count', /2 row\(s\)/.test(renamed.body.error));
  const blankFile = await pushRaw(enc('\n\n'), 'reqs.csv');
  t('a blank attachment says so rather than blaming the columns',
    /no rows at all|every one of them is blank|empty/i.test(blankFile.body.error));
  t('a missing one is caught before that', (await pushRaw('', 'reqs.csv')).body.error === 'Missing fileBase64');


  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
