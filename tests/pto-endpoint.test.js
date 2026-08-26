/* The ?ptoIntake=1 endpoint, run against the real source in functions/index.js
   with a fake bucket. This is what Power Automate posts to. */
const fs = require('fs');
const path = require('path');
const Sched = require('../schedule-core.js');
const Intake = require('../form-intake.js');
const Core = require('../reconcile-core.js');

let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
const consts = src.slice(src.indexOf('const COLLECTIONS = {'), src.indexOf('const NOTES_ORIGIN'));
const handler = src.slice(src.indexOf('async function rosterProfiles'), src.indexOf('function parseToState'));
// readJsonArray .. handleCollection also contains sanitizeRecord.
const helpers = src.slice(src.indexOf('async function readJsonArray'), src.indexOf('async function handleCollection'));

const SNAPSHOT_PATH = 'snapshots/latest.json';
const KEY = 'secret-key';
let files = {};
const bucket = {
  file: p => ({
    save: async body => { files[p] = body; },
    download: async () => { if (!files[p]) { const e = new Error('404'); e.code = 404; throw e; } return [Buffer.from(files[p])]; }
  })
};
async function readJsonFile(p) { try { return JSON.parse(files[p]); } catch (e) { return {}; } }
const SYNC_KEY = { value: () => KEY };

const built = new Function(
  'bucket', 'readJsonFile', 'SYNC_KEY', 'SNAPSHOT_PATH', 'Sched', 'Intake', 'console',
  consts + helpers + handler +
  '\nreturn {handlePtoIntake, rosterProfiles, COLLECTIONS};'
)(bucket, readJsonFile, SYNC_KEY, SNAPSHOT_PATH, Sched, Intake, console);
const { handlePtoIntake, COLLECTIONS } = built;

const mkRes = () => { const r = { code: null, body: null, set() { return r }, status(c) { r.code = c; return r }, json(b) { r.body = b; return r }, send() { return r } }; return r; };
const post = async (body, key, method) => {
  const res = mkRes();
  await handlePtoIntake({ method: method || 'POST', body, get: h => (h === 'x-sync-key' ? (key === undefined ? KEY : key) : '') }, res);
  return res;
};
const requests = () => { try { return JSON.parse(files[COLLECTIONS.timeoff.path]); } catch (e) { return []; } };

const snapshot = {
  records: [
    { badge: '215001', person: 'Luz Grachen', market: 'Chicago' },
    { badge: '215002', person: 'Abel Munoz', market: 'Chicago' }
  ]
};

(async () => {
  console.log('— auth —');
  files = {};
  t('no key rejected', (await post({ name: 'x' }, '')).code === 401);
  t('wrong key rejected', (await post({ name: 'x' }, 'nope')).code === 401);
  t('GET rejected', (await post({ name: 'x' }, KEY, 'GET')).code === 405);
  t('nothing written by a rejected call', requests().length === 0);

  console.log('— refuses to file against nobody —');
  let r = await post({ name: 'Luz Grachen', dates: '8/25/26', duration: 'A full day' });
  t('no snapshot yet -> 503, not a silent write', r.code === 503);
  t('and says why', r.body.error.indexOf('No roster snapshot') === 0);
  t('still nothing written', requests().length === 0);

  files[SNAPSHOT_PATH] = JSON.stringify(snapshot);

  console.log('— a normal submission —');
  r = await post({
    name: 'Luz Grachen', shift: '1st', location: 'lego',
    dates: '08/25/26, 08/26/26', duration: 'A full day', language: 'en', responseId: '42'
  });
  t('accepted', r.code === 200 && r.body.ok === true);
  t('one request written', r.body.written === 1);
  t('matched to a badge', r.body.results[0].matched === true);
  let list = requests();
  t('stored in the time-off collection', list.length === 1);
  t('badge resolved from the snapshot', list[0].badge === '215001');
  t('Pending, awaiting approval', list[0].status === 'Pending');
  t('16 hours for two full days', list[0].hours === 16);
  t('the name survived the whitelist', list[0].name === 'Luz Grachen');
  t('so did shift and location', list[0].shift === '1st' && list[0].location === 'lego');
  t('and the source form', list[0].source === 'Form (English)');
  t('stamped', !!list[0].updatedAt);

  console.log('— re-running the flow —');
  r = await post({
    name: 'Luz Grachen', shift: '1st', location: 'lego',
    dates: '08/25/26, 08/26/26', duration: 'A full day', language: 'en', responseId: '42'
  });
  t('same response id does not duplicate', requests().length === 1);
  t('it updates instead', r.body.written === 1);

  console.log('— an approval is never overwritten by a re-run —');
  list = requests(); list[0].status = 'Approved';
  files[COLLECTIONS.timeoff.path] = JSON.stringify(list);
  await post({
    name: 'Luz Grachen', dates: '08/25/26, 08/26/26', duration: 'A full day', language: 'en', responseId: '42'
  });
  t('the approval stands', requests()[0].status === 'Approved');

  console.log('— an unknown name is filed, not lost —');
  r = await post({ name: 'Nobody Here', dates: '9/1/26', duration: 'A full day', responseId: '43' });
  t('accepted', r.code === 200);
  t('reported as unmatched', r.body.unmatched.indexOf('Nobody Here') !== -1);
  t('but still written', requests().length === 2);
  const orphan = requests().find(x => x.name === 'Nobody Here');
  t('with no badge', orphan.badge === '');
  t('and the name kept so it can be assigned by hand', orphan.name === 'Nobody Here');

  console.log('— a submission with no usable date —');
  const before = requests().length;
  r = await post({ name: 'Abel Munoz', dates: 'whenever', duration: 'A full day', responseId: '44' });
  t('reported as a failure for that person', r.body.results[0].ok === false);
  t('with the text they typed', r.body.results[0].error.indexOf('whenever') !== -1);
  t('nothing written for it', requests().length === before);
  t('the call itself still succeeds', r.code === 200);

  console.log('— missing name —');
  r = await post({ dates: '9/1/26', duration: 'A full day' });
  t('rejected per-submission', r.body.results[0].ok === false && r.body.results[0].error === 'Missing name');

  console.log('— a batch —');
  r = await post({
    submissions: [
      { name: 'Luz Grachen', dates: '10/1/26', duration: 'A full day', responseId: '50' },
      { name: 'Abel Munoz', dates: '10/2/26', duration: 'Un día parcial', language: 'es', hours: 5, responseId: '51' }
    ]
  });
  t('both processed', r.body.results.length === 2);
  t('both written', r.body.written === 2);
  const abel = requests().find(x => x.id === 'FORM-51-0');
  t('Spanish partial day honoured', abel.hours === 5);
  t('and tagged as the Spanish form', abel.source === 'Form (Spanish)');
  t('empty batch refused', (await post({ submissions: [] })).code === 400);
  t('oversized batch refused', (await post({ submissions: new Array(201).fill({ name: 'x', dates: '9/1/26' }) })).code === 400);

  console.log('— the endpoint accepts the raw Forms body too —');
  r = await post({
    language: 'en', responseId: '77',
    fields: { name: 'rNAME', dates: 'rDATES', duration: 'rDUR', shift: 'rSHIFT' },
    response: {
      rNAME: 'Abel Munoz', rSHIFT: '2nd',
      rDATES: '12/1/26\n12/2/26',      // the multi-line case
      rDUR: 'A full day'
    }
  });
  t('accepted', r.code === 200 && r.body.ok === true);
  t('name resolved through the map', r.body.results[0].name === 'Abel Munoz');
  t('matched to a badge', r.body.results[0].matched === true);
  const multi = requests().find(x => x.id === 'FORM-77-0');
  t('newline-separated dates became one range', multi.start === '2026-12-01' && multi.end === '2026-12-02');
  t('shift came through the map', multi.shift === '2nd');
  t('missing name is still caught with the map shape',
    (await post({ fields: { name: 'rNAME' }, response: {} })).body.results[0].error === 'Missing name');

  console.log('— warnings reach the caller —');
  r = await post({ name: 'Luz Grachen', dates: '11/1/26', duration: 'A partial day', responseId: '60' });
  t('partial-day hours warning surfaced', r.body.results[0].warnings.some(x => x.indexOf('no hours were given') !== -1));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
