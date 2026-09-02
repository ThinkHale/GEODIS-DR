/* The shared IL PTO tracker endpoint (?ilPto=1).

   Fired by a flow that watches the SharePoint file for modification, which is
   what makes a same-day approval land the same day — and which also fires on a
   save made mid-edit, when the sheet is briefly missing rows. */
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };
const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');

console.log('— the endpoint exists and is guarded —');
t('it is routed', /req\.query\.ilPto !== undefined/.test(src));
t('and answers on ?ilPto=1', /function handleIlPto/.test(src));
/* The check moved into hasSyncKey(), which refuses AND logs why -- a flow
   posting with a stale key used to be turned away in total silence, which in
   the logs looks exactly like the flow never running. The guard is the same
   guard; only its expression changed. */
t('a push needs the sync key', (() => {
  const h = src.slice(src.indexOf('async function handleIlPto'));
  const body = h.slice(0, h.indexOf('\n}\n'));
  return /hasSyncKey\(req/.test(body) && /401/.test(body);
})());
t('and a refusal is logged, not swallowed', (() => {
  const h = src.slice(src.indexOf('function hasSyncKey'));
  const body = h.slice(0, h.indexOf('\n}\n'));
  return /console\.warn/.test(body) && /Refused a /.test(body);
})());

t('GET needs no key, so the page can show the last sync', (() => {
  const h = src.slice(src.indexOf('async function handleIlPto'));
  const body = h.slice(0, h.indexOf('\n}\n'));
  return body.indexOf("req.method === 'GET'") < body.indexOf('hasSyncKey');
})());
t('anything but GET or POST is refused', /Method not allowed/.test(
  src.slice(src.indexOf('async function handleIlPto'), src.indexOf('async function handleIlPto') + 900)));

console.log('— the same shape the PLX push already uses —');
t('the workbook arrives base64', /body\.fileBase64 \|\| body\.file/.test(
  src.slice(src.indexOf('async function handleIlPto'))));
t('and a missing file is a 400, not a silent success', /Missing fileBase64/.test(
  src.slice(src.indexOf('async function handleIlPto'))));

console.log('— what a mid-edit save cannot do —');
const apply = src.slice(src.indexOf('async function applyIlPtoWorkbook'),
  src.indexOf('async function handleIlPto'));
t('a workbook with none of the GEODIS tabs is refused', /None of the GEODIS tabs were found/.test(apply));
t('a workbook whose GEODIS tabs are empty is refused', /hold no GEODIS rows/.test(apply));
// The trigger fires on every save. Thirty rows vanishing at once is somebody with
// the file open, not thirty decisions.
t('there is a ceiling on tasks raised in one go', /ILPTO_MAX_AUTO_TASKS/.test(src));
t('above it, tasks are held rather than raised',
  /merged\.vanished\.length > ILPTO_MAX_AUTO_TASKS/.test(apply) && /heldTasks = merged\.vanished\.length/.test(apply));
t('and what was held is recorded, not lost', /tasksHeld/.test(apply) && /saved mid-edit/.test(apply));
t('records are written either way, because the import never deletes',
  apply.indexOf('COLLECTIONS.timeoff.path).save') > apply.indexOf('heldTasks'));

console.log('— a poll that changes nothing costs nothing —');
/* The file is on somebody else's OneDrive, shared by link, so nothing can trigger
   on modification -- that needs it in your own drive. A flow polls instead, and an
   unchanged workbook must not rewrite every record and its updatedAt stamp. */
t('an unchanged file stops before parsing', /String\(last\.modifiedAt\) === String\(opts\.modifiedAt\)/.test(apply));
t('and says it skipped rather than reporting a fresh sync', /skipped: true/.test(apply));
t('the check happens before the workbook is even read',
  apply.indexOf('opts.modifiedAt') < apply.indexOf('XLSX.read'));
// A browser upload has no file timestamp and must always apply.
t('with no modifiedAt it always applies', /if \(opts\.modifiedAt\)/.test(apply));

console.log('— either shape Power Automate sends —')
/* A binary action output is represented as {"$content-type":…,"$content":"<b64>"},
   and whether an expression hands you the bytes or that envelope depends on the
   connector and how the flow was written. base64() over the envelope yields base64
   of JSON text, which decodes to something plainly not a workbook. */
t('there is a decoder rather than one assumed shape', /function decodeWorkbookBody/.test(src));
t('it unwraps the $content envelope', /envelope\.\$content/.test(src));
t('and passes plain base64 straight through',
  /head\.indexOf\('\$content'\) === -1/.test(src));
t('a malformed envelope uses what arrived rather than throwing',
  /catch \(err\) \{ \/\* not an envelope after all/.test(src));
t('the endpoint decodes through it', /applyIlPtoWorkbook\(decodeWorkbookBody\(b64\)/.test(src));

console.log('— a shortcut is not the workbook —');
/* "Add shortcut to My files" on a single shared FILE makes a .url: a hundred-odd
   bytes of Internet Shortcut text. XLSX does not throw on it -- it reads the text
   as one sheet -- so the honest-looking failure was "none of the GEODIS tabs were
   found", which sends whoever built the flow looking at tab names. */
t('a .url shortcut is recognised for what it is', /InternetShortcut/i.test(apply));
t('and the error names it, rather than blaming the tab names',
  /is a \.url shortcut, not the workbook/.test(apply));
t('it says what to do instead', /containing folder/.test(apply));
t('anything implausibly small is refused too', /too small to be the tracker/.test(apply));
t('the size check runs before the tab check',
  apply.indexOf('too small to be the tracker') < apply.indexOf('None of the GEODIS tabs'));

console.log('— it writes through the same guards as everything else —');
t('time-off records are sanitised against the whitelist',
  /sanitizeRecord\(r, COLLECTIONS\.timeoff\.fields\)/.test(apply));
t('so are the tasks', /sanitizeRecord\(t, COLLECTIONS\.tasks\.fields\)/.test(apply));
t('ids are capped', /String\(r\.id\)\.slice\(0, 64\)/.test(apply));

console.log('— identity comes from the published roster —');
t('the EID is matched against empNumber from the snapshot',
  /readJsonFile\(SNAPSHOT_PATH\)/.test(apply) && /r\.empNumber/.test(apply));
t('the parsing is the same module the browser import uses',
  /PtoTracker\.parseTracker/.test(apply) && /PtoTracker\.toTimeOffRecords/.test(apply));
t('and so is the merge, so a push and an upload cannot diverge',
  /PtoTracker\.mergeForSave/.test(apply));
t('the status pipeline is the shared one', /pipeline: TimeOff/.test(apply));

console.log('— the browser can see what the flow did —');
t('a sync record is written', /ILPTO_META_PATH/.test(apply));
t('naming the file and when the sheet changed', /fileName:/.test(apply) && /modifiedAt:/.test(apply));
t('how many requests, matched and not', /requests:/.test(apply) && /matched:/.test(apply) && /unmatched:/.test(apply));
t('and what it could not read', /warnings:/.test(apply));

console.log('— the core it depends on ships with the function —');
['pto-tracker-core.js', 'tasks-core.js'].forEach(f => {
  const root = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const fn = fs.existsSync(path.join(__dirname, '..', 'functions', f))
    ? fs.readFileSync(path.join(__dirname, '..', 'functions', f), 'utf8') : null;
  t(f + ' is deployed with the function', fn !== null);
  // A drifted copy is how the browser and the flow start disagreeing silently.
  t(f + ' is identical to the one the browser loads', fn === root);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
