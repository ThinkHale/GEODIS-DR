/*
 * Badge Crosscheck sync function.
 *
 * HTTP-triggered. Power Automate POSTs to this endpoint once per report,
 * whenever the Beeline or CRM email arrives. It does NOT need to send
 * both files at once -- each call saves whichever file just arrived,
 * then re-reads the latest known copy of BOTH files from Storage and
 * recomputes the full snapshot. So the very first call after either file
 * changes brings the snapshot up to date.
 *
 * Expected request:
 *   POST /syncReport?type=beeline   (or ?type=crm)
 *   Header:  x-sync-key: <shared secret>
 *   Body (JSON): { "fileBase64": "<base64-encoded .xlsx bytes>" }
 *
 * Response: { ok: true, computed: true|false, counts: {...} }
 *   computed is false if this was the first file and we're still
 *   waiting on the other one.
 *
 * Deploy with the Firebase CLI from this `functions/` folder:
 *   firebase deploy --only functions:syncReport
 * Set the shared secret first:
 *   firebase functions:secrets:set SYNC_KEY
 * (See SETUP.md in the project root for the full walkthrough.)
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const XLSX = require('xlsx');
const Core = require('./reconcile-core.js');
const Sched = require('./schedule-core.js');
const Intake = require('./form-intake.js');
const TimeOff = require('./timeoff-core.js');
const Payroll = require('./payroll-core.js');
const TransitionImport = require('./transition-import.js');
const PtoTracker = require('./pto-tracker-core.js');
const Tasks = require('./tasks-core.js');
const TransitionPto = require('./transition-pto.js');
const AttendanceImport = require('./attendance-import.js');
const ReqsCore = require('./reqs-core.js');
const ShiftKey = require('./shift-key.js');
const Contacts = require('./contacts-core.js');
const Auth = require('./auth-core.js');
const MarketAccess = require('./market-access-core.js');

// Shared secret proving a request came from our Power Automate flow.
// Set with: firebase functions:secrets:set SYNC_KEY
const SYNC_KEY = defineSecret('SYNC_KEY');

admin.initializeApp();
const bucket = admin.storage().bucket();

const RAW_PATH = {
  beeline: 'raw/beeline-latest.xlsx',
  crm: 'raw/crm-latest.xlsx',
  rcended: 'raw/rcended-latest.xlsx'   // optional RC "Ended Assignments" report
};
/* The two daily Beeline requisition exports, kept apart because they arrive in
   separate emails minutes apart and each is rebuilt against whatever the other
   last was. Keyed by what ReqsCore.describe() calls the file, so the slot a file
   lands in is decided by its columns and never by its name. */
const REQ_RAW_PATH = {
  reqs: 'raw/beeline-open-reqs.xlsx',
  candidates: 'raw/beeline-candidate-status.xlsx',
  combined: 'raw/beeline-combined.xlsx'
};
const REQ_LABEL = {
  reqs: 'GEODIS Open Reqs', candidates: 'Candidate Status per Req', combined: 'combined export'
};
const SNAPSHOT_PATH = 'snapshots/latest.json';
const NOTES_PATH = 'notes/notes.json';
const OVERRIDES_PATH = 'overrides/overrides.json';   // badge -> manual status override
// Suite collections. Unlike the badge-keyed stores above these hold a list of
// records, because a person has many attendance events and many time-off
// requests, and a requisition is not tied to a badge at all.
const COLLECTIONS = {
  attendance:   { path: 'attendance/events.json',        responseKey: 'attendance',
                  fields: { badge: 'str', name: 'str', date: 'str', type: 'str', minutes: 'num', points: 'num', notes: 'str',
                            source: 'str', importRef: 'str', location: 'str', shift: 'str', historical: 'bool' } },
  timeoff:      { path: 'timeoff/requests.json',         responseKey: 'timeOff',
                  fields: { badge: 'str', name: 'str', type: 'str', start: 'str', end: 'str', hours: 'num',
                            status: 'str', notes: 'str', shift: 'str', location: 'str', source: 'str',
                            submittedAt: 'str', statusUpdatedAt: 'str', statusUpdatedBy: 'str',
                            connectedBy: 'str', connectedAt: 'str', statusHistory: 'log',
                            transitionHours: 'num', accrualHours: 'num', transitionAppliedAt: 'str',
                            legacyBalanceApplied: 'str', importRef: 'str' } },
  associatePto: { path: 'associates/pto.json',            responseKey: 'associatePto',
                  fields: { badge: 'str', name: 'str', transitionAssociate: 'str',
                            transitionPtoInitial: 'num', transitionPtoBalance: 'num',
                            source: 'str', sourceAccount: 'str', importedAt: 'str', notes: 'str' } },
  /* Requisitions. A Beeline request IS a requisition, so the daily Beeline
     export lands here rather than in a parallel list the tab would have to
     reconcile against itself. Imported rows carry source 'beeline' and are keyed
     by Request-ID; rows without that source were typed in by hand and an import
     leaves them alone (see mergeForSave in reqs-core.js). */
  requisitions: { path: 'requisitions/requisitions.json', responseKey: 'requisitions',
                  fields: { title: 'str', department: 'str', shift: 'str', market: 'str', openings: 'num',
                            filled: 'num', priority: 'str', status: 'str', due: 'str', notes: 'str',
                            building: 'str', reportTo: 'str', source: 'str',
                            /* The Beeline half of a requisition. Namespaced away from the
                               fields the PLX workbook sync writes above, so the two sources
                               land on one record without either overwriting the other. */
                            beelineReq: 'str', beelineStatus: 'str', beelineOpenings: 'num',
                            hired: 'num', submitted: 'num', declined: 'num', offered: 'num',
                            jobPosition: 'str', startDate: 'str', hiringManager: 'str',
                            supervisor: 'str', location: 'str', city: 'str', state: 'str',
                            profitCenter: 'str', updatedAt: 'str' } },
  /* Candidates attached to a Beeline request, one record per (req, person). The
     export carries no per-candidate status -- its "Status" column is the
     request's -- so none is stored; which candidate was hired is only known in
     aggregate, from the counts on the requisition. */
  reqCandidates:{ path: 'requisitions/candidates.json',   responseKey: 'reqCandidates',
                  fields: { reqId: 'str', name: 'str', beelineId: 'str', externalId: 'str',
                            badge: 'str', jobPosition: 'str', location: 'str', status: 'str' } },
  // Shift tags cross-referenced from the PLX workbook. Keyed by WFM EID where
  // there is one, name otherwise -- see shift-key.js.
  shifts:       { path: 'shifts/assignments.json',       responseKey: 'shifts',
                  fields: { eid: 'str', nameKey: 'str', name: 'str', shift: 'str', building: 'str',
                            dept: 'str', account: 'str', hours: 'str', badge: 'str', source: 'str' } },
  /* Associate phone numbers. Keyed by badge when somebody typed one in, by EID
     or name key when harvested from a sheet -- the same shape as shift tags,
     and joined onto a profile the same way. */
  contacts:     { path: 'contacts/phones.json',          responseKey: 'contacts',
                  fields: { badge: 'str', eid: 'str', nameKey: 'str', name: 'str', phone: 'str',
                            source: 'str', updatedAt: 'str', updatedBy: 'str' } },
  /* Standing tasks: work that outlives the page it was noticed on. Pending PTO
     and open discrepancies are NOT copied in here -- they are projected into
     the task shape on read, so there is only ever one record to mark done. */
  tasks:        { path: 'tasks/tasks.json',              responseKey: 'tasks',
                  fields: { kind: 'str', title: 'str', detail: 'str', badge: 'str', name: 'str',
                            market: 'str', location: 'str', assignee: 'str', due: 'str', priority: 'str',
                            status: 'str', source: 'str',
                            sourceKind: 'str', sourceId: 'str', urgentAfterHours: 'num',
                            createdAt: 'str', createdBy: 'str', updatedAt: 'str',
                            statusUpdatedAt: 'str', statusUpdatedBy: 'str', statusHistory: 'log' } },
  // Payroll discrepancies raised on the GEODIS Payroll Discrepancy Form.
  discrepancies:{ path: 'payroll/discrepancies.json',    responseKey: 'discrepancies',
                  fields: { badge: 'str', name: 'str', location: 'str', date: 'str', weekEnding: 'str',
                            details: 'str', status: 'str', source: 'str', submittedAt: 'str',
                            statusUpdatedAt: 'str', statusUpdatedBy: 'str', connectedBy: 'str',
                            connectedAt: 'str', notes: 'str', statusHistory: 'log' } },
  /* Accounts and the things an admin configures. Keyed by email for users, and
     by a stable id for the rest, so they upsert like every other collection. */
  users:        { path: 'admin/users.json',              responseKey: 'users',
                  fields: { email: 'str', uid: 'str', name: 'str', role: 'str', enabled: 'bool',
                            markets: 'list', createdAt: 'str', lastSeenAt: 'str' } },
  /* App-level settings an admin owns. Keyed by a stable id so they upsert like
     any other collection -- currently the RC (Salesforce) base URL, which turns
     a stored record id into a link somebody can click. */
  /* A timeclock id joined to a badge by hand, for people the reports spell
     differently. Keyed by the WFM id, so re-linking replaces rather than stacks. */
  timeclockLinks:{ path: 'admin/timeclock-links.json',   responseKey: 'timeclockLinks',
                  fields: { eid: 'str', badge: 'str', name: 'str', rosterName: 'str',
                            linkedBy: 'str', linkedAt: 'str' } },
  appConfig:    { path: 'admin/config.json',             responseKey: 'appConfig',
                  fields: { key: 'str', value: 'str', label: 'str' } },
  locations:    { path: 'admin/locations.json',          responseKey: 'locations',
                  fields: { code: 'str', name: 'str', market: 'str', active: 'bool', notes: 'str' } },
  shiftTypes:   { path: 'admin/shift-types.json',        responseKey: 'shiftTypes',
                  fields: { key: 'str', label: 'str', location: 'str', hours: 'str', active: 'bool' } },
  performance:  { path: 'performance/metrics.json',      responseKey: 'performance',
                  fields: { badge: 'str', period: 'str', quality: 'num', productivity: 'num', safety: 'num',
                            units: 'num', hours: 'num', notes: 'str' } }
};
// Each entry knows its own key, so a handler can look up its write permission
// without the router having to pass the name alongside the spec.
Object.keys(COLLECTIONS).forEach(k => { COLLECTIONS[k].name = k; });

/* What a caller must be able to do to write each collection. Reading any of
   them needs 'view', which is the whole point of the gate: the roster, the
   floor and everybody's attendance are the thing being protected.

   Anything not named here is ordinary day-to-day work and needs 'edit'. The
   ones named are the ones that change what OTHER people can do or see, so they
   are held higher:
     users       'roles'  -- a manager staffs their team; the specific change is
                            checked again against canGrant() below, because the
                            permission only says they may open the door.
     appConfig   'admin'  -- the RC base URL and the domain allowlist.
     locations   'admin'
     shiftTypes  'admin' */
const COLLECTION_WRITE = {
  users: 'roles', appConfig: 'admin', locations: 'admin', shiftTypes: 'admin'
};
const MAX_COLLECTION_RECORDS = 20000;
const MAX_LOG_ENTRIES = 40;

/* Date-partitioned documents. Unlike the collections above these are split by
   date, because they grow forever: a weekly schedule per week, and a day's worth
   of on-premise checks per day. Partitioning keeps any single read small and
   makes a re-upload replace exactly one document.

   The date is part of the storage path, so it is validated as a strict ISO date
   and never interpolated raw -- see dateKeyOf(). */
// Hours submitted to Beeline, one document per pay period. Each pull is compared
// with the one before it; what moved after the period closed is the point.
const PLX_META_PATH = 'plx/sync.json';     // when the workbook last landed, and what came out of it
// When each Beeline requisition export last landed, and what came out of it.
const REQ_META_PATH = 'reqs/sync.json';
/* The on-demand refresh flow's URL. Deliberately NOT a Firebase secret: a
   declared secret must exist before the function can deploy at all, which would
   make an optional feature block every deploy. It lives in the bucket instead,
   writable only with the sync key and never sent to the browser -- anyone
   holding that URL could trigger the flow. */
const PLX_CONFIG_PATH = 'plx/config.json';
const PAYROLL_DIR = 'payroll/periods';    // {weekEnding}.json
const MAX_HOURS_ROWS = 20000;
const MAX_SNAPSHOTS = 40;
const SCHEDULE_DIR = 'schedule/weeks';    // {periodStart}.json -- the plan
const COVERAGE_DIR = 'coverage/days';     // {date}.json        -- the observations
const MAX_SCHEDULE_PEOPLE = 5000;
const MAX_CHECKS_PER_DAY = 24;
const MAX_EXCEPTION_ROWS = 5000;
const MAX_PRESENT_KEYS = 20000;
const NOTES_ORIGIN = 'https://geodis.ebtools.pro';   // the tool's front-end origin

/* Power Automate represents a binary action output as
   {"$content-type":"…","$content":"<base64>"}, and whether an expression hands you
   the bytes or that envelope depends on the connector and on how the flow was
   written. base64() over the envelope yields base64 of the JSON text, which
   decodes to something that is plainly not a workbook and sends whoever built the
   flow hunting for the wrong thing.

   Both forms are accepted instead, because which one a given flow produces is not
   worth a debugging round trip. */
function decodeWorkbookBody(b64) {
  const buf = Buffer.from(b64, 'base64');
  const head = buf.slice(0, 60).toString('utf8');
  if (head.indexOf('$content') === -1) return buf;
  try {
    const envelope = JSON.parse(buf.toString('utf8'));
    if (envelope && typeof envelope.$content === 'string') {
      return Buffer.from(envelope.$content, 'base64');
    }
  } catch (err) { /* not an envelope after all; use what arrived */ }
  return buf;
}

/* A real .xlsx is a ZIP starting with "PK\x03\x04". */
function isXlsxZip(b) {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}
/* Power Automate's "Get Attachment (V2)" often DOUBLE-base64-encodes contentBytes:
   one decode yields the ASCII base64 TEXT of the real file (it starts "UEsD"). If
   the first decode is not a ZIP but looks like base64 text, unwrap one more layer.

   Returns the buffer unchanged when unwrapping does not produce a workbook, so a
   file that is legitimately not a ZIP -- a .csv export -- passes through intact
   rather than being mangled by a second decode. Every flow posting an attachment
   goes through here; the behaviour was learned once, on the reconciliation feed,
   and must not be re-learned per endpoint. */
function unwrapDoubleBase64(buffer) {
  if (isXlsxZip(buffer)) return buffer;
  const asText = buffer.toString('latin1');
  if (asText.length >= 8 && /^[A-Za-z0-9+/=\s]+$/.test(asText.slice(0, 200))) {
    const inner = Buffer.from(asText, 'base64');
    if (isXlsxZip(inner)) return inner;
  }
  return buffer;
}

/* What a Power Automate flow actually posted, whichever of the two shapes its
   connector produced. Both quirks were learned the hard way on feeds already
   running; a new flow should not have to rediscover either. */
function flowAttachment(b64) {
  return unwrapDoubleBase64(decodeWorkbookBody(b64));
}

async function readRawFile(type) {
  try {
    const [buf] = await bucket.file(RAW_PATH[type]).download();
    return buf;
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}

/* ---------- shared, badge-keyed stores (notes + status overrides) ----------
   Read and written from the browser, both behind requireUser(): a note against a
   badge is about a named person, and a status override changes what the whole
   team sees. Reading needs 'view', writing needs 'edit'. The Origin check and
   the payload limits stay, but neither is the control -- the account is. */
async function readJsonFile(path) {
  try {
    const [buf] = await bucket.file(path).download();
    return JSON.parse(buf.toString());
  } catch (err) {
    return {};
  }
}
function setKvCors(res) {
  res.set('Access-Control-Allow-Origin', NOTES_ORIGIN);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // Authorization carries the Firebase ID token. Without it here every
  // authenticated request dies at the preflight, which reads as "the server is
  // down" rather than "the browser was never allowed to ask".
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '3600');
}
// Generic badge -> { <field>, updatedAt } store. Empty value deletes the entry.
// opts: { path, field, responseKey, maxLen, allowed? (whitelist of valid values) }
async function handleKv(req, res, opts) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method === 'GET') {
    if (!await requireUser(req, res, 'view')) return;
    res.set('Cache-Control', 'no-cache, max-age=0');
    res.status(200).json({ ok: true, [opts.responseKey]: await readJsonFile(opts.path) });
    return;
  }
  if (req.method === 'POST') {
    if (req.get('origin') !== NOTES_ORIGIN) { res.status(403).json({ ok: false, error: 'Forbidden origin' }); return; }
    if (!await requireUser(req, res, 'edit')) return;
    const badge = req.body && req.body.badge != null ? String(req.body.badge).trim() : '';
    let value = req.body && req.body[opts.field] != null ? String(req.body[opts.field]) : '';
    if (!badge || badge.length > 64) { res.status(400).json({ ok: false, error: 'Missing/invalid badge' }); return; }
    if (value.length > opts.maxLen) value = value.slice(0, opts.maxLen);
    if (opts.allowed && value.trim() !== '' && opts.allowed.indexOf(value.trim()) === -1) {
      res.status(400).json({ ok: false, error: 'Invalid ' + opts.field }); return;
    }
    const store = await readJsonFile(opts.path);
    if (value.trim() === '') delete store[badge];
    else store[badge] = { [opts.field]: value, updatedAt: new Date().toISOString() };
    await bucket.file(opts.path).save(JSON.stringify(store), {
      contentType: 'application/json',
      metadata: { cacheControl: 'no-cache, max-age=0' }
    });
    res.status(200).json({ ok: true });
    return;
  }
  res.status(405).json({ ok: false, error: 'Method not allowed' });
}

/* ---------- shared suite collections ----------
   A collection is a JSON array of records, each carrying a stable `id`. One POST
   either upserts a single record, deletes one (`_delete`), or replaces the whole
   list (`records`) -- the last of these is how a morning report import will land.
   Writes are gated by the same CORS + Origin check as the badge-keyed stores. */
async function readJsonArray(path) {
  const data = await readJsonFile(path);
  return Array.isArray(data) ? data : [];
}
// Copy only whitelisted fields, coercing to the declared type. Anything the
// browser sends that we did not declare is dropped rather than stored.
function sanitizeRecord(raw, fields) {
  const out = {};
  Object.keys(fields).forEach(k => {
    if (raw[k] === undefined || raw[k] === null) return;
    if (fields[k] === 'num') {
      const n = Number(raw[k]);
      if (Number.isFinite(n)) out[k] = n;
    } else if (fields[k] === 'bool') {
      out[k] = raw[k] === true || raw[k] === 'true';
    } else if (fields[k] === 'list') {
      if (!Array.isArray(raw[k])) return;
      out[k] = raw[k].slice(0, 100).map(v => String(v == null ? '' : v).slice(0, 120)).filter(Boolean);
    } else if (fields[k] === 'log') {
      // An append-only change log: who set which status, when. Entries are
      // shaped here rather than trusted, and the log is capped so a client
      // cannot grow a record without bound.
      if (!Array.isArray(raw[k])) return;
      out[k] = raw[k].slice(-MAX_LOG_ENTRIES).map(e => ({
        status: String((e && e.status) || '').slice(0, 60),
        at: String((e && e.at) || '').slice(0, 40),
        by: String((e && e.by) || '').slice(0, 80),
        byId: String((e && e.byId) || '').slice(0, 64),
        source: String((e && e.source) || '').slice(0, 24),
        note: String((e && e.note) || '').slice(0, 200)
      }));
    } else {
      out[k] = String(raw[k]).slice(0, 500);
    }
  });
  return out;
}
/* Resolve the authoritative joins a market-scoped collection may need. A read
   failure produces an empty context via readJsonFile(), which intentionally
   resolves nothing for a restricted account instead of falling open. */
async function marketContextForCollection(name) {
  const needsLocations = name === 'requisitions' || name === 'reqCandidates' ||
    name === 'shifts' || name === 'shiftTypes';
  const [snapshot, locations, requisitions] = await Promise.all([
    readJsonFile(SNAPSHOT_PATH),
    needsLocations ? readJsonArray(COLLECTIONS.locations.path) : Promise.resolve(null),
    name === 'reqCandidates' ? readJsonArray(COLLECTIONS.requisitions.path) : Promise.resolve(null)
  ]);
  const context = { snapshot };
  if (locations) context.locations = locations;
  if (requisitions) context.requisitions = requisitions;
  return context;
}
function denyMarketWrite(res) {
  res.status(403).json({ ok: false, forbidden: true,
    error: 'That record is outside your assigned markets or has no verified market.' });
}
async function handleCollection(req, res, opts) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method === 'GET') {
    const actor = await requireUser(req, res, 'view');
    if (!actor) return;
    res.set('Cache-Control', 'no-cache, max-age=0');
    let rows = await readJsonArray(opts.path);
    if (MarketAccess.hasRestriction(actor)) {
      rows = MarketAccess.filterRecords(actor, opts.name, rows,
        await marketContextForCollection(opts.name));
    }
    /* An address in ADMIN_EMAILS is raised to admin on EVERY sign-in. Changing
       its role from Settings therefore appears to work and then quietly reverts
       the next time they sign in -- the worst kind of failure, because the
       person who made the change has already moved on believing it took.

       So the account list says which rows are pinned, and the UI refuses to
       offer a control that cannot hold. The flag is computed on read rather
       than stored: it is a property of how the function is deployed today, not
       of the account, and storing it would leave it wrong the moment the
       variable changed. */
    if (opts.name === 'users') {
      const pinned = bootstrapAdmins();
      if (pinned.length) {
        rows = rows.map(u => pinned.indexOf(Auth.normalizeEmail(u && u.email)) === -1
          ? u : Object.assign({}, u, { pinnedRole: 'admin' }));
      }
    }
    res.status(200).json({ ok: true, [opts.responseKey]: rows });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  if (req.get('origin') !== NOTES_ORIGIN) { res.status(403).json({ ok: false, error: 'Forbidden origin' }); return; }
  const actor = await requireUser(req, res, COLLECTION_WRITE[opts.name] || 'edit');
  if (!actor) return;
  const restricted = MarketAccess.hasRestriction(actor);
  const marketContext = restricted ? await marketContextForCollection(opts.name) : null;

  const body = req.body || {};
  const now = new Date().toISOString();
  let list;
  let associatePto;

  if (Array.isArray(body.records)) {
    // Bulk replace, used by report imports. Not available for accounts: it would
    // replace the whole list in one write and walk straight past the per-record
    // canManage/canGrant checks below.
    if (opts.name === 'users') {
      res.status(403).json({ ok: false, forbidden: true,
        error: 'Accounts are changed one at a time, so each change can be checked.' });
      return;
    }
    if (body.records.length > MAX_COLLECTION_RECORDS) {
      res.status(400).json({ ok: false, error: 'Too many records' }); return;
    }
    const incoming = body.records.map((raw, i) => {
      const rec = sanitizeRecord(raw || {}, opts.fields);
      rec.id = raw && raw.id != null ? String(raw.id).slice(0, 64) : opts.responseKey + '-' + Date.now() + '-' + i;
      rec.updatedAt = now;
      return rec;
    });
    if (restricted) {
      const existing = await readJsonArray(opts.path);
      const mergedBulk = MarketAccess.mergeRestrictedReplace(actor, opts.name, existing, incoming, marketContext);
      if (!mergedBulk.ok) { denyMarketWrite(res); return; }
      if (mergedBulk.records.length > MAX_COLLECTION_RECORDS) {
        res.status(409).json({ ok: false,
          error: 'The market-scoped import cannot be merged without exceeding the collection limit.' });
        return;
      }
      list = mergedBulk.records;
    } else {
      list = incoming;
    }
  } else {
    const id = body.id != null ? String(body.id).trim() : '';
    if (!id || id.length > 64) { res.status(400).json({ ok: false, error: 'Missing/invalid id' }); return; }
    list = await readJsonArray(opts.path);
    const idx = list.findIndex(x => x && x.id === id);
    if (body._delete) {
      if (idx === -1) { res.status(200).json({ ok: true, deleted: false }); return; }
      if (restricted && !MarketAccess.recordDecision(actor, opts.name, list[idx], marketContext).allowed) {
        denyMarketWrite(res); return;
      }
      if (opts.name === 'users' && !Auth.canManage(actor, Auth.normalizeUser(list[idx]))) {
        res.status(403).json({ ok: false, forbidden: true,
          error: 'That account is not one you can remove.' });
        return;
      }
      if (opts.responseKey === 'timeOff') {
        associatePto = await readJsonArray(COLLECTIONS.associatePto.path);
        TransitionPto.release(list[idx], associatePto, now);
      }
      list.splice(idx, 1);
    } else {
      if (idx === -1 && list.length >= MAX_COLLECTION_RECORDS) {
        res.status(400).json({ ok: false, error: 'Collection is full' }); return;
      }
      const rec = sanitizeRecord(body, opts.fields);
      rec.id = id;
      rec.updatedAt = now;
      const merged = idx === -1 ? rec : Object.assign({}, list[idx], rec);
      if (restricted && idx !== -1 &&
          !MarketAccess.recordDecision(actor, opts.name, list[idx], marketContext).allowed) {
        denyMarketWrite(res); return;
      }
      /* Changing an account is the one write where the permission is not the
         whole answer. 'roles' says a manager may open this door; WHICH change
         they may make depends on the account in front of them and the role they
         are reaching for -- a manager may set a colleague to manager and must
         never be able to set anybody, including themselves, to admin.

         Checked here rather than trusted from the client, because the role
         arrives as a string in a POST body and a <select> is not a permission. */
      if (opts.name === 'users') {
        const target = Auth.normalizeUser(idx === -1 ? merged : list[idx]);
        if (!Auth.canManage(actor, target)) {
          res.status(403).json({ ok: false, forbidden: true,
            error: target.email === Auth.normalizeEmail(actor.email)
              ? 'You cannot change your own access.'
              : 'That account is above your own, so you cannot change it.' });
          return;
        }
        if (body.role !== undefined && bootstrapAdmins().indexOf(target.email) !== -1) {
          res.status(409).json({ ok: false, forbidden: true,
            error: 'That account is pinned to Administrator by the deployment (ADMIN_EMAILS), ' +
              'so a role set here would be undone at its next sign-in.' });
          return;
        }
        if (body.role !== undefined && !Auth.canGrant(actor, target, body.role)) {
          res.status(403).json({ ok: false, forbidden: true,
            error: 'The ' + Auth.roleMeta(actor.role).label + ' role cannot grant ' +
              Auth.roleMeta(body.role).label + '.' });
          return;
        }
        // The uid and the sign-in stamps belong to sign-in, not to whoever is
        // editing the row. Never let an edit rewrite them.
        merged.uid = list[idx] ? list[idx].uid || '' : merged.uid || '';
        merged.createdAt = list[idx] ? list[idx].createdAt || now : merged.createdAt || now;
        merged.lastSeenAt = list[idx] ? list[idx].lastSeenAt || '' : '';
      }
      if (restricted && !MarketAccess.recordDecision(actor, opts.name, merged, marketContext).allowed) {
        denyMarketWrite(res); return;
      }
      if (opts.responseKey === 'timeOff') {
        associatePto = await readJsonArray(COLLECTIONS.associatePto.path);
        TransitionPto.apply(idx === -1 ? null : list[idx], merged, associatePto, now);
      }
      if (idx === -1) list.push(merged);
      else list[idx] = merged;
    }
  }

  await bucket.file(opts.path).save(JSON.stringify(list), {
    contentType: 'application/json',
    metadata: { cacheControl: 'no-cache, max-age=0' }
  });
  if (associatePto) {
    await bucket.file(COLLECTIONS.associatePto.path).save(JSON.stringify(associatePto), {
      contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' }
    });
  }
  const visible = restricted
    ? MarketAccess.filterRecords(actor, opts.name, list, marketContext) : list;
  const visiblePto = associatePto && restricted
    ? MarketAccess.filterRecords(actor, 'associatePto', associatePto, marketContext) : associatePto;
  res.status(200).json({ ok: true, count: visible.length,
    record: body.id ? visible.find(x => x && x.id === String(body.id).trim()) || null : null,
    associatePto: visiblePto || undefined });
}


/* ---------- date-partitioned documents (schedule + coverage) ----------
   A schedule document is the plan for one week; a coverage document is every
   on-premise check taken on one day, plus whatever a manager documented about
   the people who were not there. */

// The only thing that ever reaches a storage path. Anything that is not exactly
// YYYY-MM-DD is refused, so no caller can walk out of the directory.
function dateKeyOf(v) {
  const s = v == null ? '' : String(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}
function str(v, max) { return v == null ? '' : String(v).slice(0, max || 200); }
function auditActor(actor) {
  actor = actor || {};
  return {
    by: str(actor.name || actor.email || actor.id || 'Unknown', 120),
    // Account ids are normalized emails throughout the suite data model. Keep
    // audit records on that stable contract rather than Firebase-provider ids.
    byId: str(actor.id || actor.email, 254)
  };
}
/* Browser close-time writes arrive as ISO instants. Date.parse() alone is too
   permissive (and normalizes impossible dates), so validate every component
   before accepting the value. Empty remains the explicit "clear" operation. */
function strictInstant(v) {
  const value = v == null ? '' : String(v).trim();
  if (!value) return '';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  const maxDay = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (!maxDay || day < 1 || day > maxDay || hour > 23 || minute > 59 || second > 59) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

async function listDateKeys(dir) {
  const [files] = await bucket.getFiles({ prefix: dir + '/' });
  return files
    .map(f => (f.name.split('/').pop() || '').replace(/\.json$/, ''))
    .filter(k => dateKeyOf(k))
    .sort();
}

/* Authoritative ownership inputs for the date-partitioned documents. The
   roster verifies badge/EID ownership; configured locations verify WFM site
   paths and payroll location labels. A failed read yields empty inputs through
   readJsonFile/readJsonArray, so a restricted request resolves nothing rather
   than falling open. */
async function datedMarketContext() {
  const [snapshot, locations] = await Promise.all([
    readJsonFile(SNAPSHOT_PATH), readJsonArray(COLLECTIONS.locations.path)
  ]);
  return { snapshot: snapshot, locations: locations };
}
function weekStartKey(date) {
  const key = dateKeyOf(date);
  if (!key) return '';
  const value = new Date(key + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() - value.getUTCDay());
  return value.toISOString().slice(0, 10);
}
async function coverageMarketContext(date, base) {
  const context = Object.assign({}, base || await datedMarketContext());
  const schedule = await readJsonFile(SCHEDULE_DIR + '/' + weekStartKey(date) + '.json');
  context.schedulePeople = Array.isArray(schedule.people) ? schedule.people : [];
  return context;
}
function hasScheduleRows(doc) { return !!(doc && Array.isArray(doc.people) && doc.people.length); }
function hasCoverageRows(doc) {
  return !!(doc && ((Array.isArray(doc.checks) && doc.checks.length) ||
    (doc.documented && Object.keys(doc.documented).length)));
}
function hasPayrollRows(doc) {
  return !!(doc && ((Array.isArray(doc.snapshots) && doc.snapshots.length) ||
    (Array.isArray(doc.changes) && doc.changes.length)));
}
function visiblePayrollPeriod(actor, period, context) {
  const visible = MarketAccess.filterPayroll(actor, period, context);
  if (!MarketAccess.hasRestriction(actor) || !visible || !Object.keys(visible).length) return visible;
  const source = period && period.reviews && typeof period.reviews === 'object'
    ? period.reviews : {};
  const reviews = {};
  (Array.isArray(visible.changes) ? visible.changes : []).forEach(change => {
    const key = Payroll.changeKey(change);
    if (Object.prototype.hasOwnProperty.call(source, key)) reviews[key] = source[key];
  });
  return Object.assign({}, visible, { reviews: reviews });
}

/* GET  ?schedule=1                     -> { periods: [...] }
   GET  ?schedule=1&period=YYYY-MM-DD   -> the stored week
   POST ?schedule=1&period=YYYY-MM-DD   -> replace that week  */
async function handleSchedule(req, res) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  // The week's plan is roster data: reading it needs an account, writing one
  // needs somebody trusted with imports.
  const actor = await requireUser(req, res, req.method === 'GET' ? 'view' : 'import');
  if (!actor) return;
  const restricted = MarketAccess.hasRestriction(actor);
  const marketContext = restricted ? await datedMarketContext() : null;
  const period = dateKeyOf(req.query.period);

  if (req.method === 'GET') {
    res.set('Cache-Control', 'no-cache, max-age=0');
    if (!period) {
      let periods = await listDateKeys(SCHEDULE_DIR);
      if (restricted) {
        const visible = await Promise.all(periods.map(async key => ({
          key: key,
          schedule: MarketAccess.filterSchedule(actor,
            await readJsonFile(SCHEDULE_DIR + '/' + key + '.json'), marketContext)
        })));
        periods = visible.filter(row => hasScheduleRows(row.schedule)).map(row => row.key);
      }
      res.status(200).json({ ok: true, periods: periods }); return;
    }
    const stored = await readJsonFile(SCHEDULE_DIR + '/' + period + '.json');
    res.status(200).json({ ok: true,
      schedule: restricted ? MarketAccess.filterSchedule(actor, stored, marketContext) : stored });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  if (req.get('origin') !== NOTES_ORIGIN) { res.status(403).json({ ok: false, error: 'Forbidden origin' }); return; }
  if (!period) { res.status(400).json({ ok: false, error: 'Missing/invalid period' }); return; }

  const body = req.body || {};
  const people = Array.isArray(body.people) ? body.people : null;
  if (!people) { res.status(400).json({ ok: false, error: 'Missing people' }); return; }
  if (people.length > MAX_SCHEDULE_PEOPLE) { res.status(400).json({ ok: false, error: 'Too many people' }); return; }

  // shifts is a date -> shift map; keep only well-formed dates and flatten each
  // shift to the few fields the suite renders.
  let doc = {
    periodStart: period,
    periodEnd: dateKeyOf(body.periodEnd) || '',
    fileName: str(body.fileName, 300),
    executedAt: str(body.executedAt, 60),
    uploadedAt: new Date().toISOString(),
    people: people.map(p => {
      const shifts = {};
      const src = (p && p.shifts) || {};
      Object.keys(src).forEach(d => {
        if (!dateKeyOf(d)) return;
        const sh = src[d] || {};
        shifts[d] = {
          raw: str(sh.raw, 60),
          start: Number.isFinite(Number(sh.start)) ? Number(sh.start) : null,
          end: Number.isFinite(Number(sh.end)) ? Number(sh.end) : null,
          overnight: !!sh.overnight,
          code: str(sh.code, 40)
        };
      });
      return {
        name: str(p && p.name, 120),
        nameKey: str(p && p.nameKey, 120),
        badge: str(p && p.badge, 64),
        wfmId: str(p && p.wfmId, 64),
        location: str(p && p.location, 200),
        job: str(p && p.job, 120),
        shifts: shifts
      };
    })
  };
  if (restricted) {
    const path = SCHEDULE_DIR + '/' + period + '.json';
    const existing = await readJsonFile(path);
    const currentPeople = Array.isArray(existing.people) ? existing.people : [];
    const merged = MarketAccess.mergeRestrictedReplace(
      actor, 'schedule', currentPeople, doc.people, marketContext);
    if (!merged.ok) { denyMarketWrite(res); return; }
    if (merged.records.length > MAX_SCHEDULE_PEOPLE) {
      res.status(409).json({ ok: false,
        error: 'The market-scoped schedule cannot be merged without exceeding the weekly limit.' });
      return;
    }
    // Only the people array is partitioned. Keep existing document metadata
    // where present so one market's upload does not rewrite another market's
    // source filename or execution stamp.
    doc = Object.assign({}, doc, {
      periodEnd: existing.periodEnd || doc.periodEnd,
      fileName: existing.fileName || doc.fileName,
      executedAt: existing.executedAt || doc.executedAt,
      people: merged.records
    });
  }
  await bucket.file(SCHEDULE_DIR + '/' + period + '.json').save(JSON.stringify(doc), {
    contentType: 'application/json',
    metadata: { cacheControl: 'no-cache, max-age=0' }
  });
  const visiblePeople = restricted
    ? MarketAccess.filterRecords(actor, 'schedule', doc.people, marketContext).length : doc.people.length;
  res.status(200).json({ ok: true, period: period, people: visiblePeople });
}

/* GET  ?coverage=1                   -> { dates: [...] }
   GET  ?coverage=1&date=YYYY-MM-DD   -> that day's checks + documentation
   POST ?coverage=1&date=...  { check }     -> append one on-premise check
   POST ?coverage=1&date=...  { document }  -> document one person's absence  */
async function handleCoverage(req, res) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  // Who was on the floor, and what a supervisor wrote about the people who were
  // not. Reading needs an account; documenting somebody's day needs 'edit'.
  const actor = await requireUser(req, res, req.method === 'GET' ? 'view' : 'edit');
  if (!actor) return;
  const restricted = MarketAccess.hasRestriction(actor);
  const date = dateKeyOf(req.query.date);

  if (req.method === 'GET') {
    res.set('Cache-Control', 'no-cache, max-age=0');
    if (!date) {
      let dates = await listDateKeys(COVERAGE_DIR);
      if (restricted) {
        const base = await datedMarketContext();
        const visible = await Promise.all(dates.map(async key => {
          const [coverage, context] = await Promise.all([
            readJsonFile(COVERAGE_DIR + '/' + key + '.json'), coverageMarketContext(key, base)
          ]);
          return { key: key, coverage: MarketAccess.filterCoverage(actor, coverage, context) };
        }));
        dates = visible.filter(row => hasCoverageRows(row.coverage)).map(row => row.key);
      }
      res.status(200).json({ ok: true, dates: dates }); return;
    }
    const coverage = await readJsonFile(COVERAGE_DIR + '/' + date + '.json');
    const context = restricted ? await coverageMarketContext(date) : null;
    res.status(200).json({ ok: true,
      coverage: restricted ? MarketAccess.filterCoverage(actor, coverage, context) : coverage });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  if (req.get('origin') !== NOTES_ORIGIN) { res.status(403).json({ ok: false, error: 'Forbidden origin' }); return; }
  if (!date) { res.status(400).json({ ok: false, error: 'Missing/invalid date' }); return; }

  const path = COVERAGE_DIR + '/' + date + '.json';
  const existing = await readJsonFile(path);
  const marketContext = restricted ? await coverageMarketContext(date) : null;
  const doc = {
    date: date,
    checks: Array.isArray(existing.checks) ? existing.checks : [],
    documented: (existing.documented && typeof existing.documented === 'object') ? existing.documented : {},
    updatedAt: new Date().toISOString()
  };
  const body = req.body || {};

  if (body.check) {
    const c = body.check;
    const exceptions = Array.isArray(c.exceptions) ? c.exceptions.slice(0, MAX_EXCEPTION_ROWS) : [];
    const present = Array.isArray(c.presentKeys) ? c.presentKeys.slice(0, MAX_PRESENT_KEYS) : [];
    const check = {
      id: str(c.id, 64) || 'CK' + Date.now(),
      asOf: str(c.asOf, 40),
      fileName: str(c.fileName, 300),
      graceMinutes: Number.isFinite(Number(c.graceMinutes)) ? Number(c.graceMinutes) : null,
      summary: (c.summary && typeof c.summary === 'object') ? c.summary : {},
      // Full detail for anyone who was not where they should be...
      exceptions: exceptions.map(r => ({
        key: str(r.key, 140), name: str(r.name, 120), badge: str(r.badge, 64), wfmId: str(r.wfmId, 64),
        status: str(r.status, 24), present: !!r.present, shift: str(r.shift, 60),
        location: str(r.location, 200), job: str(r.job, 120), manager: str(r.manager, 120)
      })),
      // ...and a bare key list for everyone who WAS on premise, so presence can
      // still be proven later without storing a row per person per pull.
      presentKeys: present.map(k => str(k, 140)),
      savedAt: new Date().toISOString()
    };
    // Re-running the same pull replaces it rather than double-counting the day.
    const i = doc.checks.findIndex(x => x && x.id === check.id);
    if (restricted) {
      const incoming = MarketAccess.coverageCheckDecision(actor, check, marketContext);
      if (!incoming.allowed) { denyMarketWrite(res); return; }
      // A matching id owned partly or wholly by another market cannot be safely
      // replaced: its compact aggregate cannot be split after the fact. Reject
      // atomically, preserving the stored check byte-for-byte.
      if (i !== -1 && !MarketAccess.coverageCheckDecision(
        actor, doc.checks[i], marketContext).allowed) {
        denyMarketWrite(res); return;
      }
    }
    if (i === -1) doc.checks.push(check); else doc.checks[i] = check;
    doc.checks.sort((a, b) => String(a.asOf || '').localeCompare(String(b.asOf || '')));
    if (doc.checks.length > MAX_CHECKS_PER_DAY) {
      if (restricted) {
        res.status(409).json({ ok: false,
          error: 'The market-scoped check cannot be saved without removing another market\'s history.' });
        return;
      }
      doc.checks = doc.checks.slice(-MAX_CHECKS_PER_DAY);
    }
  } else if (body.document) {
    const dRec = body.document;
    const key = str(dRec.key, 140);
    if (!key) { res.status(400).json({ ok: false, error: 'Missing document key' }); return; }
    if (restricted && !MarketAccess.recordDecision(actor, 'coverage', {
      key: key, badge: str(dRec.badge, 64), name: str(dRec.name, 120)
    }, marketContext).allowed) {
      denyMarketWrite(res); return;
    }
    // An empty reason clears the entry rather than storing a blank note.
    if (!str(dRec.reason, 500).trim() && !str(dRec.disposition, 60).trim()) {
      delete doc.documented[key];
    } else {
      const audit = auditActor(actor);
      doc.documented[key] = {
        reason: str(dRec.reason, 500),
        disposition: str(dRec.disposition, 60),
        name: str(dRec.name, 120),
        badge: str(dRec.badge, 64),
        updatedAt: new Date().toISOString(),
        updatedBy: audit.by,
        updatedById: audit.byId
      };
    }
  } else {
    res.status(400).json({ ok: false, error: 'Expected a check or a document' });
    return;
  }

  await bucket.file(path).save(JSON.stringify(doc), {
    contentType: 'application/json',
    metadata: { cacheControl: 'no-cache, max-age=0' }
  });
  const visible = restricted ? MarketAccess.filterCoverage(actor, doc, marketContext) : doc;
  res.status(200).json({ ok: true, date: date,
    checks: Array.isArray(visible.checks) ? visible.checks.length : 0 });
}

/* ---------- PTO requests from Microsoft Forms ----------
   Power Automate posts one canonical payload per submission, for either form.
   This runs server-side rather than in the flow because the form gives a NAME
   and the roster is keyed by badge, so the name has to be resolved against the
   current snapshot -- and because "which date(s)" is free text. See
   form-intake.js.

   Authenticated with the same x-sync-key as the report ingest: this is a
   server-to-server call, so there is no browser origin to check. */
async function rosterProfiles() {
  try {
    const [buf] = await bucket.file(SNAPSHOT_PATH).download();
    const snap = JSON.parse(buf.toString());
    return (snap.records || []).map(r => ({
      badge: String(r.badge || ''),
      name: r.person || r.crmName || r.beeName || '',
      market: r.market || ''
    })).filter(p => p.badge && p.name);
  } catch (err) {
    return [];
  }
}

/* ---------- one-time transition PTO / payroll workbook import ----------
   Authenticated like the report feeds. Records are merged by deterministic id,
   so re-running the same workbook is safe and does not erase newer work. */
async function handleTransitionImport(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }
  if (!SYNC_KEY.value() || req.get('x-sync-key') !== SYNC_KEY.value()) {
    res.status(401).json({ ok: false, error: 'Unauthorized' }); return;
  }
  const b64 = req.body && req.body.fileBase64;
  if (!b64) { res.status(400).json({ ok: false, error: 'Missing fileBase64' }); return; }
  const profiles = await rosterProfiles();
  if (!profiles.length) { res.status(503).json({ ok: false, error: 'No roster snapshot is available' }); return; }
  const byName = Intake.buildNameIndex(profiles, Sched.rosterKey);
  let built;
  try {
    built = TransitionImport.build(Buffer.from(b64, 'base64'), {
      byName, rosterKey: Sched.rosterKey, source: String((req.body && req.body.fileName) || 'Transition PTO workbook').slice(0, 200),
      now: new Date().toISOString()
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: 'The workbook could not be read: ' + err.message }); return;
  }
  const required = ['Transition Employees PTO Balanc', 'PTO Request Off', 'Payroll Discrepencies'];
  const missing = required.filter(n => built.sheets.indexOf(n) === -1);
  if (missing.length) { res.status(400).json({ ok: false, error: 'Missing sheet(s): ' + missing.join(', ') }); return; }

  async function merge(path, incoming, preserveWorkflow) {
    const existing = await readJsonArray(path), byId = new Map(existing.map(x => [x.id, x]));
    incoming.forEach(x => {
      const old = byId.get(x.id);
      if (old && preserveWorkflow) {
        ['status', 'statusUpdatedAt', 'statusUpdatedBy', 'statusHistory', 'connectedBy', 'connectedAt']
          .forEach(k => { if (old[k] !== undefined) x[k] = old[k]; });
        if (old.badge) x.badge = old.badge;
      }
      byId.set(x.id, Object.assign({}, old || {}, x, { updatedAt: new Date().toISOString() }));
    });
    const out = Array.from(byId.values());
    await bucket.file(path).save(JSON.stringify(out), { contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' } });
    return out.length;
  }
  const counts = {
    associatePto: await merge(COLLECTIONS.associatePto.path, built.associatePto, false),
    timeOff: await merge(COLLECTIONS.timeoff.path, built.timeOff, true),
    discrepancies: await merge(COLLECTIONS.discrepancies.path, built.discrepancies, true)
  };
  res.status(200).json({ ok: true, counts, imported: {
    transitionAssociates: built.associatePto.length, timeOff: built.timeOff.length, discrepancies: built.discrepancies.length,
    unmatchedTransition: built.associatePto.filter(x => !x.badge).length,
    unmatchedTimeOff: built.timeOff.filter(x => !x.badge).length,
    unmatchedDiscrepancies: built.discrepancies.filter(x => !x.badge).length
  } });
}

async function handleAttendanceImport(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }
  if (!SYNC_KEY.value() || req.get('x-sync-key') !== SYNC_KEY.value()) { res.status(401).json({ ok: false, error: 'Unauthorized' }); return; }
  const body = req.body || {}; if (!body.plxBase64 || !body.redbullBase64) { res.status(400).json({ ok: false, error: 'Both workbook files are required' }); return; }
  const profiles = await rosterProfiles(); if (!profiles.length) { res.status(503).json({ ok: false, error: 'No roster snapshot is available' }); return; }
  const byName = Intake.buildNameIndex(profiles, Sched.rosterKey), now = new Date().toISOString(); let built;
  try {
    built = AttendanceImport.build(Buffer.from(body.plxBase64, 'base64'), Buffer.from(body.redbullBase64, 'base64'), {
      byName, rosterKey: Sched.rosterKey, asOf: now.slice(0, 10), plxSource: String(body.plxName || 'PLX - Geodis Spreadsheet.xlsx').slice(0, 200),
      redbullSource: String(body.redbullName || 'Redbull Attendance Tracker_2026.xlsx').slice(0, 200)
    });
  } catch (err) { res.status(400).json({ ok: false, error: 'The workbooks could not be read: ' + err.message }); return; }
  const existing = await readJsonArray(COLLECTIONS.attendance.path);
  /* Rows written under the OLD id scheme, which hashed the file name, are the
     same occurrences under different ids -- three copies of the ledger, one per
     download. Anything matching an occurrence in this import by person, day and
     type is dropped unless it IS that occurrence, which clears the duplicates
     on the next upload. Matching on the signature rather than on a prefix means
     hand-logged rows and imports from other trackers are left alone. */
  const sigOf = x => [Sched.rosterKey(x.name || ''), x.date || '', x.type || ''].join('|');
  const incomingIds = new Set(built.events.map(x => x.id));
  const incomingSigs = new Set(built.events.map(sigOf));
  const superseded = existing.filter(x => x && !incomingIds.has(x.id) && incomingSigs.has(sigOf(x)));
  const byId = new Map(existing
    .filter(x => x && (incomingIds.has(x.id) || !incomingSigs.has(sigOf(x))))
    .map(x => [x.id, x]));
  built.events.forEach(x => byId.set(x.id, Object.assign({}, byId.get(x.id) || {}, sanitizeRecord(x, COLLECTIONS.attendance.fields), { id: x.id, updatedAt: now })));
  await bucket.file(COLLECTIONS.attendance.path).save(JSON.stringify(Array.from(byId.values())), { contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' } });
  const pto = await readJsonArray(COLLECTIONS.associatePto.path), ptoByBadge = new Map(pto.filter(x => x.badge).map(x => [String(x.badge), x]));
  built.transitions.forEach(x => {
    if (!x.badge) return; const old = ptoByBadge.get(String(x.badge));
    if (old) { old.transitionAssociate = 'true'; old.updatedAt = now; }
    else { const rec = { id: 'TP-HC-' + x.badge, badge: x.badge, name: x.name, transitionAssociate: 'true', transitionPtoInitial: 0,
      transitionPtoBalance: 0, source: body.plxName || 'PLX headcount', importedAt: now, notes: 'Transition flag imported from ' + x.source, updatedAt: now };
      pto.push(rec); ptoByBadge.set(String(x.badge), rec); }
  });
  await bucket.file(COLLECTIONS.associatePto.path).save(JSON.stringify(pto), { contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' } });
  res.status(200).json({ ok: true, imported: built.summary, attendanceCount: byId.size,
    supersededDuplicates: superseded.length, associatePtoCount: pto.length });
}

/* ---------- the daily Beeline requisition exports ----------
   Two exports land by email each morning -- "GEODIS Open Reqs" (req-level
   openings and pipeline counts) and "Candidate Status per Req" (who is attached
   to each req). A Power Automate flow watching the Outlook folder they are filed
   into POSTs each attachment here as it arrives. See SETUP.md.

   WHICH export a file is, is read off its COLUMNS -- ReqsCore.describe() already
   tells the two apart -- never off the file name or the subject line. Both
   attachments come out of the same folder, a renamed export is routine, and
   routing on a name would silently overwrite the wrong half.

   Nothing waits for both. Each push rebuilds the board from EVERY stored half,
   so the 6am reqs email publishes immediately and the 6:05 candidate email adds
   to it -- rather than the first email publishing a board with no candidates and
   wiping the list the previous morning left. */
function reqAoaFrom(buffer) {
  // The same read the browser import does, so a file gives the same board
  // whichever way it arrived. raw:true keeps 04/27/2026 as written.
  const wb = XLSX.read(buffer, { type: 'buffer', raw: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}
async function parseStoredReqExport(kind, fileName) {
  try {
    const [buf] = await bucket.file(REQ_RAW_PATH[kind]).download();
    const parsed = ReqsCore.parseExport(reqAoaFrom(buf), fileName || REQ_LABEL[kind]);
    return parsed.reqs.length ? parsed : null;
  } catch (err) {
    return null;
  }
}

async function handleReqSync(req, res) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method === 'GET') {
    if (!await requireUser(req, res, 'view')) return;
    res.set('Cache-Control', 'no-cache, max-age=0');
    res.status(200).json({ ok: true, sync: await readJsonFile(REQ_META_PATH) });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  const expected = SYNC_KEY.value();
  if (!expected || req.get('x-sync-key') !== expected) { res.status(401).json({ ok: false, error: 'Unauthorized' }); return; }

  const body = req.body || {};
  const b64 = String(body.fileBase64 || body.file || '');
  if (!b64) { res.status(400).json({ ok: false, error: 'Missing fileBase64' }); return; }
  const fileName = String(body.fileName || '').slice(0, 200) || 'Beeline export';
  const buffer = flowAttachment(b64);

  /* Nothing is written until the file proves it is a requisition export. A flow
     that fires on the wrong email, or an attachment Power Automate mangled, must
     not overwrite the half that was working -- the same rule the reconciliation
     feed learned. */
  let parsed;
  try {
    parsed = ReqsCore.parseExport(reqAoaFrom(buffer), fileName);
  } catch (err) {
    res.status(400).json({ ok: false, error: 'The export could not be read: ' + err.message +
      '. It was not saved; the previous export is kept.' });
    return;
  }
  if (!parsed.reqs.length) {
    res.status(400).json({ ok: false, error: (parsed.warnings[0] || 'No requests were found in this file.') +
      ' It was not saved; the previous export is kept.', fileName });
    return;
  }
  const kind = ReqsCore.describe(parsed);
  if (!REQ_RAW_PATH[kind]) {
    /* Request-IDs, but neither an openings column nor a candidate column. It is
       not either export, and guessing a slot for it would replace a good half
       with something unusable. Name what it did carry, so the export can be
       fixed rather than debugged blind. */
    res.status(400).json({ ok: false, fileName,
      error: 'This file has Request-IDs but neither a "Candidates Requested" nor a "Candidate" column, ' +
        'so it is neither of the two exports. It was not saved; the previous exports are kept.',
      columnsFound: Object.keys(parsed.has || {}).filter(k => parsed.has[k]) });
    return;
  }

  const now = new Date().toISOString();
  await bucket.file(REQ_RAW_PATH[kind]).save(buffer, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });

  const meta = await readJsonFile(REQ_META_PATH);
  const sources = meta && typeof meta.sources === 'object' && meta.sources ? meta.sources : {};
  sources[kind] = { fileName, receivedAt: now, rowCount: parsed.rowCount,
    reqs: parsed.reqs.length, candidates: parsed.candidates.length };

  /* Re-read every other half from storage. The one that just arrived is used as
     parsed rather than round-tripped through the bucket. */
  const warnings = [];
  const loaded = [];
  for (const k of Object.keys(REQ_RAW_PATH)) {
    if (!sources[k]) continue;
    const p = k === kind ? parsed : await parseStoredReqExport(k, sources[k].fileName);
    if (p) { loaded.push({ at: sources[k].receivedAt || '', parsed: p }); continue; }
    sources[k].unreadable = true;
    warnings.push('The stored ' + REQ_LABEL[k] + ' could not be re-read, so this board was built without it.');
  }
  /* Newest first. buildBoard lets the FIRST source win every field it fills, so
     the order decides which export's answer survives where the two overlap. A
     half that stopped arriving must not keep outvoting today's file. */
  loaded.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const locations = await readJsonArray(COLLECTIONS.locations.path);
  const board = ReqsCore.buildBoard({ sources: loaded.map(s => s.parsed), locations });
  const reqRecords = ReqsCore.toReqRecords(board);
  const candRecords = ReqsCore.toCandidateRecords(board);
  const existing = await readJsonArray(COLLECTIONS.requisitions.path);
  const merged = ReqsCore.mergeForSave(existing, reqRecords);

  if (merged.length > MAX_COLLECTION_RECORDS || candRecords.length > MAX_COLLECTION_RECORDS) {
    res.status(400).json({ ok: false, error: 'That export would store more than ' + MAX_COLLECTION_RECORDS +
      ' records. Nothing was changed.' });
    return;
  }
  // Same shaping the browser import gets on its way through handleCollection:
  // declared fields only, id preserved, updatedAt stamped.
  const stamp = (rows, fields) => rows.map(r => {
    const rec = sanitizeRecord(r, fields);
    rec.id = String(r.id).slice(0, 64);
    rec.updatedAt = now;
    return rec;
  });
  await bucket.file(COLLECTIONS.requisitions.path).save(
    JSON.stringify(stamp(merged, COLLECTIONS.requisitions.fields)),
    { contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' } });
  await bucket.file(COLLECTIONS.reqCandidates.path).save(
    JSON.stringify(stamp(candRecords, COLLECTIONS.reqCandidates.fields)),
    { contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' } });

  const missing = ReqsCore.missingColumns(loaded.map(s => s.parsed));
  const sync = {
    syncedAt: now,
    lastKind: kind,
    lastLabel: REQ_LABEL[kind],
    lastFileName: fileName,
    sources: sources,
    reqs: reqRecords.length,
    candidates: candRecords.length,
    missing: missing.map(m => ({ label: m.label, why: m.why })),
    warnings: warnings.concat(board.warnings).slice(0, 20)
  };
  await bucket.file(REQ_META_PATH).save(JSON.stringify(sync), {
    contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' }
  });
  res.status(200).json({ ok: true, kind, sync });
}

async function handlePtoIntake(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }
  const expected = SYNC_KEY.value();
  if (!expected || req.get('x-sync-key') !== expected) {
    res.status(401).json({ ok: false, error: 'Unauthorized' }); return;
  }

  const body = req.body || {};
  // One submission, or a batch if the flow is catching up.
  const subs = Array.isArray(body.submissions) ? body.submissions : [body];
  if (!subs.length || subs.length > 200) {
    res.status(400).json({ ok: false, error: 'Expected 1-200 submissions' }); return;
  }

  const profiles = await rosterProfiles();
  if (!profiles.length) {
    // Without a roster every request would land unattached. Refuse rather than
    // quietly filing a day of PTO against nobody.
    res.status(503).json({ ok: false, error: 'No roster snapshot available yet; retry after the morning sync.' });
    return;
  }
  const byName = Intake.buildNameIndex(profiles, Sched.rosterKey);

  const list = await readJsonArray(COLLECTIONS.timeoff.path);
  const results = [];
  let written = 0;

  for (const sub of subs) {
    const flat = Intake.normalizeSubmission(sub);
    if (!flat || !String(flat.name || '').trim()) {
      results.push({ ok: false, error: 'Missing name', name: '' });
      continue;
    }
    const out = Intake.toRequests(flat, { byName, rosterKey: Sched.rosterKey });
    if (!out.records.length) {
      results.push({
        ok: false, name: flat.name, error: 'No usable dates in "' + String(flat.dates || '') + '"',
        warnings: out.warnings
      });
      continue;
    }
    out.records.forEach(rec => {
      const clean = sanitizeRecord(rec, COLLECTIONS.timeoff.fields);
      clean.id = String(rec.id).slice(0, 64);
      clean.updatedAt = new Date().toISOString();
      const i = list.findIndex(x => x && x.id === clean.id);
      // A re-run of the same Forms response updates its request rather than
      // creating a second one -- but never silently overwrites an approval that
      // someone has already made.
      if (i === -1) { list.push(clean); written++; }
      else {
        const current = TimeOff.normalizeStatus(list[i].status);
        const kept = current !== TimeOff.DEFAULT_STATUS ? list[i].status : clean.status;
        list[i] = Object.assign({}, list[i], clean, { status: kept });
        written++;
      }
    });
    results.push({
      ok: true, name: flat.name, badge: out.records[0].badge || '',
      matched: out.matched, ambiguous: out.ambiguous,
      requests: out.records.map(r => ({ id: r.id, start: r.start, end: r.end, hours: r.hours })),
      warnings: out.warnings
    });
  }

  if (list.length > MAX_COLLECTION_RECORDS) {
    res.status(400).json({ ok: false, error: 'Time-off collection is full' }); return;
  }
  if (written) {
    await bucket.file(COLLECTIONS.timeoff.path).save(JSON.stringify(list), {
      contentType: 'application/json',
      metadata: { cacheControl: 'no-cache, max-age=0' }
    });
  }
  res.status(200).json({
    ok: true, written: written,
    unmatched: results.filter(r => r.ok && !r.matched).map(r => r.name),
    results: results
  });
}

/* ---------- payroll discrepancy intake ----------
   Same contract as the PTO intake, including the raw-response + field-map shape,
   so both Power Automate flows are built the same way. */
async function handleDiscrepancyIntake(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }
  const expected = SYNC_KEY.value();
  if (!expected || req.get('x-sync-key') !== expected) {
    res.status(401).json({ ok: false, error: 'Unauthorized' }); return;
  }
  const body = req.body || {};
  const subs = Array.isArray(body.submissions) ? body.submissions : [body];
  if (!subs.length || subs.length > 200) {
    res.status(400).json({ ok: false, error: 'Expected 1-200 submissions' }); return;
  }

  const profiles = await rosterProfiles();
  if (!profiles.length) {
    res.status(503).json({ ok: false, error: 'No roster snapshot available yet; retry after the morning sync.' });
    return;
  }
  const byName = Intake.buildNameIndex(profiles, Sched.rosterKey);
  const list = await readJsonArray(COLLECTIONS.discrepancies.path);
  const results = [];
  let written = 0;

  for (const sub of subs) {
    const flat = Intake.normalizeSubmission(sub, ['name', 'location', 'date', 'details']);
    if (!flat || !String(flat.name || '').trim()) {
      results.push({ ok: false, error: 'Missing name', name: '' });
      continue;
    }
    const out = Payroll.toDiscrepancy(flat, { byName, rosterKey: Sched.rosterKey });
    const clean = sanitizeRecord(out.record, COLLECTIONS.discrepancies.fields);
    clean.id = String(out.record.id).slice(0, 64);
    clean.updatedAt = new Date().toISOString();
    const i = list.findIndex(x => x && x.id === clean.id);
    if (i === -1) { list.push(clean); }
    else {
      // A re-run must not drag a discrepancy back to Received once somebody has
      // started working it.
      const current = Payroll.pipeline.normalizeStatus(list[i].status);
      const kept = current !== Payroll.pipeline.DEFAULT_STATUS ? list[i].status : clean.status;
      list[i] = Object.assign({}, list[i], clean, { status: kept });
    }
    written++;
    results.push({
      ok: true, id: clean.id, name: flat.name, badge: clean.badge || '',
      matched: out.matched, ambiguous: out.ambiguous, warnings: out.warnings
    });
  }

  if (list.length > MAX_COLLECTION_RECORDS) {
    res.status(400).json({ ok: false, error: 'Discrepancy collection is full' }); return;
  }
  await bucket.file(COLLECTIONS.discrepancies.path).save(JSON.stringify(list), {
    contentType: 'application/json',
    metadata: { cacheControl: 'no-cache, max-age=0' }
  });
  res.status(200).json({
    ok: true, written: written,
    unmatched: results.filter(r => r.ok && !r.matched).map(r => r.name),
    results: results
  });
}

/* ---------- hours submitted to Beeline ----------
   GET  ?payroll=1                     -> { periods: [...] }
   GET  ?payroll=1&week=YYYY-MM-DD     -> that period
   POST ?payroll=1&week=... { rows, takenAt, source }  -> add a pull, diff it
   POST ?payroll=1&week=... { closesAt }               -> record when it closed
   POST ?payroll=1&week=... { review }                  -> review one stored change

   Writing hours needs the sync key, because that is an automation. Close and
   review changes are made by a person in the browser, so they take an account
   and the exact app origin instead. */
async function handlePayroll(req, res) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  const week = dateKeyOf(req.query.week);

  if (req.method === 'GET') {
    // Everyone's hours for a pay period. Read only by an account.
    const actor = await requireUser(req, res, 'view');
    if (!actor) return;
    const restricted = MarketAccess.hasRestriction(actor);
    res.set('Cache-Control', 'no-cache, max-age=0');
    if (!week) {
      let periods = await listDateKeys(PAYROLL_DIR);
      if (restricted) {
        const context = await datedMarketContext();
        const visible = await Promise.all(periods.map(async key => ({
          key: key,
          period: visiblePayrollPeriod(actor,
            await readJsonFile(PAYROLL_DIR + '/' + key + '.json'), context)
        })));
        periods = visible.filter(row => hasPayrollRows(row.period)).map(row => row.key);
      }
      res.status(200).json({ ok: true, periods: periods }); return;
    }
    const stored = await readJsonFile(PAYROLL_DIR + '/' + week + '.json');
    const context = restricted ? await datedMarketContext() : null;
    res.status(200).json({ ok: true,
      period: restricted ? visiblePayrollPeriod(actor, stored, context) : stored });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  if (!week) { res.status(400).json({ ok: false, error: 'Missing/invalid week' }); return; }

  const body = req.body || {};
  const hasClose = body.closesAt !== undefined;
  const hasReview = body.review !== undefined;
  const hasRows = Array.isArray(body.rows);
  if ((hasClose ? 1 : 0) + (hasReview ? 1 : 0) + (hasRows ? 1 : 0) !== 1) {
    res.status(400).json({ ok: false, error: 'Expected exactly one of rows, closesAt, or review' });
    return;
  }

  let browserActor = null;
  let closeValue = null;
  let reviewInput = null;
  if (hasClose || hasReview) {
    if (req.get('origin') !== NOTES_ORIGIN) {
      res.status(403).json({ ok: false, error: 'Forbidden origin' }); return;
    }
    browserActor = await requireUser(req, res, 'edit');
    if (!browserActor) return;
  }
  if (hasClose) {
    // The cutoff is global to the whole stored period. Until the schema carries
    // a per-market cutoff, a restricted account cannot change it safely.
    if (MarketAccess.hasRestriction(browserActor)) { denyMarketWrite(res); return; }
    closeValue = strictInstant(body.closesAt);
    if (closeValue === null) {
      res.status(400).json({ ok: false, error: 'Invalid closesAt timestamp' }); return;
    }
  } else if (hasReview) {
    const review = body.review;
    if (!review || typeof review !== 'object' || Array.isArray(review)) {
      res.status(400).json({ ok: false, error: 'Invalid payroll review' }); return;
    }
    const rawKey = review.key == null ? '' : String(review.key).trim();
    const note = review.note == null ? '' : String(review.note);
    if (!/^CHG-[a-z0-9]+$/.test(rawKey) || rawKey.length > 64) {
      res.status(400).json({ ok: false, error: 'Missing/invalid payroll change key' }); return;
    }
    if (review.reviewed !== true && review.reviewed !== false) {
      res.status(400).json({ ok: false, error: 'Invalid reviewed state' }); return;
    }
    if (note.length > 500) {
      res.status(400).json({ ok: false, error: 'Review note must be 500 characters or fewer' }); return;
    }
    reviewInput = { key: rawKey, reviewed: review.reviewed, note: note };
  } else if (hasRows) {
    // The automation is a separate privileged principal and posts the complete
    // report. A browser token never substitutes for its sync key.
    if (req.get('x-sync-key') !== SYNC_KEY.value()) { res.status(401).json({ ok: false, error: 'Unauthorized' }); return; }
    if (body.rows.length > MAX_HOURS_ROWS) { res.status(400).json({ ok: false, error: 'Too many rows' }); return; }
  }

  const path = PAYROLL_DIR + '/' + week + '.json';
  const existing = await readJsonFile(path);
  const now = new Date().toISOString();
  const period = {
    weekEnding: week,
    closesAt: existing.closesAt || '',
    closeBy: str(existing.closeBy, 120),
    closeById: str(existing.closeById, 254),
    closeUpdatedAt: str(existing.closeUpdatedAt, 40),
    snapshots: Array.isArray(existing.snapshots) ? existing.snapshots : [],
    changes: Array.isArray(existing.changes) ? existing.changes : [],
    reviews: existing.reviews && typeof existing.reviews === 'object' && !Array.isArray(existing.reviews)
      ? Object.assign({}, existing.reviews) : {},
    updatedAt: now
  };

  if (hasClose) {
    const audit = auditActor(browserActor);
    period.closesAt = closeValue;
    period.closeBy = audit.by;
    period.closeById = audit.byId;
    period.closeUpdatedAt = now;
  } else if (hasReview) {
    const matches = period.changes.filter(change => Payroll.changeKey(change) === reviewInput.key);
    if (MarketAccess.hasRestriction(browserActor)) {
      const context = await datedMarketContext();
      if (matches.length !== 1 ||
          !MarketAccess.recordDecision(browserActor, 'payroll', matches[0], context).allowed) {
        denyMarketWrite(res); return;
      }
    } else if (matches.length !== 1) {
      res.status(matches.length ? 409 : 404).json({ ok: false,
        error: matches.length ? 'Payroll change key is ambiguous' : 'Payroll change was not found' });
      return;
    }
    if (reviewInput.reviewed === false) {
      delete period.reviews[reviewInput.key];
    } else {
      const audit = auditActor(browserActor);
      period.reviews[reviewInput.key] = {
        note: reviewInput.note,
        by: audit.by,
        byId: audit.byId,
        at: now
      };
    }
  } else if (hasRows) {
    const takenAt = String(body.takenAt || new Date().toISOString()).slice(0, 40);
    const prior = period.snapshots.length ? period.snapshots[period.snapshots.length - 1] : null;
    const next = { weekEnding: week, takenAt: takenAt, rows: body.rows };
    const diff = Payroll.compareHours(prior, next, { closesAt: period.closesAt });

    period.snapshots.push({
      takenAt: takenAt,
      source: String(body.source || '').slice(0, 200),
      summary: diff.summary,
      // Only the last pull keeps its full rows; older ones keep their summary and
      // the changes they produced. A period holds weeks of pulls otherwise.
      rows: next.rows.map(r => ({
        badge: String((r && r.badge) || '').slice(0, 64),
        name: String((r && r.name) || '').slice(0, 120),
        hours: Number(r && r.hours) || 0,
        location: String((r && r.location) || '').slice(0, 200),
        status: String((r && r.status) || '').slice(0, 60)
      }))
    });
    period.snapshots.forEach((s, i) => { if (i < period.snapshots.length - 1) delete s.rows; });
    if (period.snapshots.length > MAX_SNAPSHOTS) period.snapshots = period.snapshots.slice(-MAX_SNAPSHOTS);
    if (diff.changes.length) period.changes = period.changes.concat(diff.changes).slice(-MAX_HOURS_ROWS);

    await bucket.file(path).save(JSON.stringify(period), {
      contentType: 'application/json',
      metadata: { cacheControl: 'no-cache, max-age=0' }
    });
    res.status(200).json({
      ok: true, weekEnding: week, baseline: diff.baseline,
      afterClose: diff.afterClose, changes: diff.changes.length, summary: diff.summary
    });
    return;
  }

  await bucket.file(path).save(JSON.stringify(period), {
    contentType: 'application/json',
    metadata: { cacheControl: 'no-cache, max-age=0' }
  });
  if (hasReview) {
    res.status(200).json({ ok: true, weekEnding: week, key: reviewInput.key,
      reviewed: reviewInput.reviewed,
      review: period.reviews[reviewInput.key] || null });
    return;
  }
  res.status(200).json({ ok: true, weekEnding: week, closesAt: period.closesAt,
    closeBy: period.closeBy, closeById: period.closeById,
    closeUpdatedAt: period.closeUpdatedAt });
}

/* ---------- the live PLX workbook ----------
   The browser cannot read SharePoint: it is a different origin and needs
   Microsoft 365 auth, and this tool has none. So Power Automate reads the
   workbook and posts it here, exactly as it already does for the daily reports.

   Two things come out of it: the shift tag for every associate, and the open
   orders on the Beeline Reqs tab. Both are merged over what is already stored --
   a refresh must never wipe something a person filled in by hand. */
/* ---------- applying the workbook ----------
   Shared by the automated push and the browser upload, so the two cannot drift
   into producing different results from the same file. Returns a result rather
   than writing a response, because its two callers answer differently. */
async function applyPlxWorkbook(buffer, opts) {
  opts = opts || {};
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (err) {
    return { ok: false, status: 400, error: 'Could not read the workbook: ' + err.message };
  }

  const sheets = wb.SheetNames.map(n => ({
    name: n,
    aoa: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' })
  }));
  /* XLSX does not throw on a file that is not a workbook -- it happily reads
     rubbish as a single CSV-ish sheet. Without this, the wrong file would record
     a perfectly successful-looking sync that produced nothing. */
  const recognised = sheets.filter(x =>
    ShiftKey.KEY_SHEET.test(x.name) || ShiftKey.HC_SHEET.test(x.name) || ShiftKey.REQ_SHEET.test(x.name));
  if (!recognised.length) {
    return { ok: false, status: 400,
      error: 'That file has none of the expected tabs (Geodis Key, "<site> - HC", Beeline Reqs). ' +
        'Tabs found: ' + wb.SheetNames.slice(0, 10).join(', ') };
  }

  const warnings = [];
  const keySheet = sheets.filter(x => ShiftKey.KEY_SHEET.test(x.name))[0];
  const key = keySheet ? ShiftKey.parseShiftKey(keySheet.aoa) : null;
  if (!key) warnings.push('No "Geodis Key" tab was found, so shift hours are unknown.');
  else warnings.push(...key.warnings);
  const hc = ShiftKey.parseHeadcount(sheets, Sched.rosterKey);
  warnings.push(...hc.warnings, ...ShiftKey.validateAgainstKey(hc, key));
  const shiftRecords = ShiftKey.toShiftRecords(hc, key);

  if (shiftRecords.length) {
    /* A shift set by hand in the suite is not in the workbook, so replacing the
       collection wholesale would erase it. Hand-set tags are kept, except where
       the workbook now covers the same person: two records for one name would
       poison each other and leave that associate with no shift at all. */
    const fromBook = shiftRecords.map(r => Object.assign(
      sanitizeRecord(r, COLLECTIONS.shifts.fields),
      { id: String(r.id).slice(0, 64), updatedAt: new Date().toISOString() }
    ));
    const bookNames = new Set(fromBook.map(r => r.nameKey).filter(Boolean));
    const existingShifts = await readJsonArray(COLLECTIONS.shifts.path);
    const superseded = [];
    const kept = existingShifts.filter(r => {
      if (!r || r.source === 'PLX workbook') return false;
      if (r.nameKey && bookNames.has(r.nameKey)) { superseded.push(r.name || r.nameKey); return false; }
      return true;
    });
    if (superseded.length) {
      warnings.push(superseded.length + ' shift tag(s) set by hand are now in the workbook and were ' +
        'replaced by it: ' + superseded.slice(0, 8).join(', ') +
        (superseded.length > 8 ? ' and ' + (superseded.length - 8) + ' more' : '') + '.');
    }
    await bucket.file(COLLECTIONS.shifts.path).save(JSON.stringify(fromBook.concat(kept)), {
      contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' }
    });
  } else {
    warnings.push('No "<site> - HC" tabs were found, so shift tags were left as they were.');
  }

  /* Phone numbers, from any sheet that has a name column and a phone column.
     Deliberately not tied to the HC tabs: the numbers currently live in a
     tracker somebody already keeps, and a rule that reads whatever sheet
     carries them means that tracker can be pasted in as a tab rather than
     re-keyed. If a Phone column is ever added to the HC tabs, this picks it up
     with no further change. */
  const phones = new Map();
  const phoneNotes = [];
  sheets.forEach(sh => {
    const got = Contacts.fromSheet(sh.aoa, Sched.rosterKey);
    got.warnings.forEach(x => phoneNotes.push(sh.name + ': ' + x));
    got.rows.forEach(r => {
      const rec = Contacts.record({
        eid: r.eid, nameKey: r.nameKey, name: r.name, phone: r.phone,
        source: 'PLX workbook · ' + sh.name
      }, null, new Date());
      phones.set(rec.id, rec);
    });
  });
  if (phones.size) {
    /* Hand-entered numbers are keyed by badge and so never collide with these,
       which are keyed by EID or name. That is the point: somebody who typed a
       number against a profile has said something the sheet cannot overrule. */
    const existing = await readJsonArray(COLLECTIONS.contacts.path);
    const kept = existing.filter(r => r && !phones.has(r.id));
    const merged = kept.concat(Array.from(phones.values()).map(r =>
      Object.assign(sanitizeRecord(r, COLLECTIONS.contacts.fields), { id: r.id })));
    await bucket.file(COLLECTIONS.contacts.path).save(JSON.stringify(merged), {
      contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' }
    });
    warnings.push(phones.size + ' phone number(s) were read from the workbook.');
  }
  // Said even when no numbers landed: a column full of unreadable values is
  // worth knowing about precisely when nothing came of it.
  phoneNotes.forEach(x => warnings.push(x));

  const reqSheet = sheets.filter(x => ShiftKey.REQ_SHEET.test(x.name))[0];
  let reqCount = 0;
  if (!reqSheet) {
    warnings.push('No "Beeline Reqs" tab was found, so open orders were left as they were.');
  } else {
    const parsed = ShiftKey.parseRequisitions(reqSheet.aoa);
    warnings.push(...parsed.warnings);
    const incoming = ShiftKey.toRequisitionRecords(parsed);
    const existing = await readJsonArray(COLLECTIONS.requisitions.path);
    const byId = new Map(existing.map(r => [r.id, r]));
    incoming.forEach(rec => {
      const clean = sanitizeRecord(rec, COLLECTIONS.requisitions.fields);
      clean.id = String(rec.id).slice(0, 64);
      clean.updatedAt = new Date().toISOString();
      const prior = byId.get(clean.id);
      // The sheet tracks neither how many are filled nor where a req stands, so
      // both stay as whatever somebody last set here.
      clean.filled = prior && Number.isFinite(Number(prior.filled)) ? Number(prior.filled) : 0;
      const openings = Number(clean.openings) || 0;
      clean.status = prior && prior.status ? prior.status
        : (openings > 0 && clean.filled >= openings ? 'Filled' : 'Open');
      byId.set(clean.id, Object.assign({}, prior || {}, clean));
    });
    // A req that has left the sheet was closed out there. Mark it rather than
    // deleting it, so its history and anything filled against it survive.
    const live = new Set(incoming.map(r => r.id));
    byId.forEach((rec, id) => {
      if (rec.source === 'PLX workbook' && !live.has(id) && rec.status !== 'Closed') {
        byId.set(id, Object.assign({}, rec, { status: 'Closed', updatedAt: new Date().toISOString() }));
      }
    });
    reqCount = incoming.length;
    await bucket.file(COLLECTIONS.requisitions.path).save(JSON.stringify(Array.from(byId.values())), {
      contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' }
    });
  }

  const meta = {
    syncedAt: new Date().toISOString(),
    fileName: String(opts.fileName || '').slice(0, 300),
    modifiedAt: String(opts.modifiedAt || '').slice(0, 40),
    uploadedBy: String(opts.uploadedBy || '').slice(0, 80),
    shiftTags: shiftRecords.length,
    sites: hc.sheets.length,
    openOrders: reqCount,
    warnings: warnings.slice(0, 20)
  };
  await bucket.file(PLX_META_PATH).save(JSON.stringify(meta), {
    contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' }
  });
  return { ok: true, meta: meta };
}

async function handlePlx(req, res) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  if (req.method === 'GET') {
    if (!await requireUser(req, res, 'view')) return;
    res.set('Cache-Control', 'no-cache, max-age=0');
    const meta = await readJsonFile(PLX_META_PATH);
    const conf = await readJsonFile(PLX_CONFIG_PATH);
    meta.onDemand = !!(conf && conf.flowUrl);
    res.status(200).json({ ok: true, sync: meta });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  if (req.get('x-sync-key') !== SYNC_KEY.value()) { res.status(401).json({ ok: false, error: 'Unauthorized' }); return; }

  const body = req.body || {};

  // Setting the on-demand refresh flow's URL, rather than pushing a workbook.
  if (body.flowUrl !== undefined) {
    const flowUrl = String(body.flowUrl || '').trim().slice(0, 2000);
    if (flowUrl && !/^https:\/\//i.test(flowUrl)) {
      res.status(400).json({ ok: false, error: 'flowUrl must be an https URL, or empty to clear it' });
      return;
    }
    await bucket.file(PLX_CONFIG_PATH).save(JSON.stringify({ flowUrl: flowUrl, updatedAt: new Date().toISOString() }), {
      contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' }
    });
    res.status(200).json({ ok: true, configured: !!flowUrl });
    return;
  }

  const b64 = String(body.fileBase64 || body.file || '');
  if (!b64) { res.status(400).json({ ok: false, error: 'Missing fileBase64' }); return; }
  const applied = await applyPlxWorkbook(Buffer.from(b64, 'base64'), {
    fileName: body.fileName, modifiedAt: body.modifiedAt
  });
  if (!applied.ok) { res.status(applied.status || 400).json({ ok: false, error: applied.error }); return; }
  res.status(200).json({ ok: true, sync: applied.meta });
}

/* ---------- the shared IL PTO tracker ----------
   The workbook belongs to another branch and reaches us as a shared link on
   somebody else's OneDrive. Nothing can trigger on it being modified: that needs
   the file in your own drive, and a link grants no folder access. So a flow reads
   it on a recurrence and pushes it here.

   Polling means a run can land on a save made mid-edit, when the sheet is briefly
   missing rows somebody is moving between tabs. Two things make that survivable.
   The import never deletes, so a row that is briefly absent keeps its record
   either way. And the tasks it would otherwise raise are held when too many
   requests vanish at once: one person moving a row is a question worth asking,
   thirty disappearing together is somebody with the file open, and asking thirty
   times teaches people to ignore the tasks. What was held is recorded, so it is
   visible rather than lost. */
const ILPTO_META_PATH = 'timeoff/il-tracker.json';
const ILPTO_SOURCE = 'IL Shared PTO Tracker';
const ILPTO_MAX_AUTO_TASKS = 5;

async function applyIlPtoWorkbook(buffer, opts) {
  opts = opts || {};

  /* The file lives on somebody else's OneDrive, shared by link, so nothing can
     trigger on it being modified -- that needs the file in your own drive. A flow
     polls it instead, and a poll that re-imports an unchanged workbook every few
     minutes would rewrite all 56 records and their updatedAt stamps for nothing.

     So the flow sends the file's own lastModifiedDateTime and this stops early
     when it has not moved. The poll costs a read; only a real edit costs a write.
     Sending no modifiedAt always applies, which is what a browser upload does. */
  if (opts.modifiedAt) {
    const last = await readJsonFile(ILPTO_META_PATH);
    if (last && last.modifiedAt && String(last.modifiedAt) === String(opts.modifiedAt)) {
      return { ok: true, meta: Object.assign({}, last, { skipped: true, checkedAt: new Date().toISOString() }) };
    }
  }

  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (err) {
    return { ok: false, status: 400, error: 'Could not read the workbook: ' + err.message };
  }
  const sheets = wb.SheetNames.map(n => ({
    name: n,
    aoa: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' })
  }));

  /* A OneDrive shortcut to a file is a .url -- a hundred-odd bytes of Internet
     Shortcut text, not the workbook. XLSX does not throw on it; it reads the text
     as a single sheet, so without this the flow would report "none of the GEODIS
     tabs were found" and send whoever built it looking at tab names. Say what
     actually arrived instead. */
  if (buffer.length < 4096 || (sheets.length === 1 && wb.SheetNames[0] === 'Sheet1')) {
    const head = buffer.slice(0, 200).toString('utf8');
    if (/\[InternetShortcut\]/i.test(head) || /^\s*URL\s*=/im.test(head)) {
      return { ok: false, status: 400,
        error: 'That is a .url shortcut, not the workbook — ' + buffer.length + ' bytes of link text. ' +
          'A OneDrive shortcut to a single FILE is a pointer, and reading it returns the pointer. ' +
          'Share the containing folder and add a shortcut to that, or read the file from its own ' +
          'SharePoint site instead.' };
    }
    if (buffer.length < 4096) {
      return { ok: false, status: 400,
        error: 'That file is only ' + buffer.length + ' bytes, which is too small to be the tracker. ' +
          'Check that the flow is reading the workbook itself and not a shortcut or an error page.' };
    }
  }

  const parsed = PtoTracker.parseTracker(sheets);
  if (!parsed.sheets.length) {
    return { ok: false, status: 400,
      error: 'None of the GEODIS tabs were found. Expected 30080, GEODIS - 20062 and 20062 Geodis Processed.' };
  }
  if (!parsed.requests.length) {
    // A save caught mid-edit can read as a valid workbook with nothing on it.
    return { ok: false, status: 400, error: 'The GEODIS tabs were read but hold no GEODIS rows.' };
  }

  // EID -> badge, from the roster snapshot the reconciliation already publishes.
  const snapshot = await readJsonFile(SNAPSHOT_PATH);
  const byEid = {};
  ((snapshot && snapshot.records) || []).forEach(r => {
    const e = String(r.empNumber || '').trim();
    if (e && !byEid[e]) byEid[e] = r.badge;
  });

  const built = PtoTracker.toTimeOffRecords(parsed, {
    badgeForEid: e => byEid[String(e || '').trim()] || '',
    source: ILPTO_SOURCE,
    pipeline: TimeOff
  });

  const existing = await readJsonArray(COLLECTIONS.timeoff.path);
  const merged = PtoTracker.mergeForSave(existing, built.records, ILPTO_SOURCE);

  let raised = [];
  let heldTasks = 0;
  if (merged.vanished.length > ILPTO_MAX_AUTO_TASKS) {
    heldTasks = merged.vanished.length;
  } else if (merged.vanished.length) {
    const tasks = await readJsonArray(COLLECTIONS.tasks.path);
    raised = PtoTracker.vanishedTasks(merged.vanished, {
      tasks: Tasks, existing: tasks, source: ILPTO_SOURCE
    });
    if (raised.length) {
      const cleaned = tasks.concat(raised.map(t => {
        const c = sanitizeRecord(t, COLLECTIONS.tasks.fields);
        c.id = String(t.id).slice(0, 64);
        return c;
      }));
      await bucket.file(COLLECTIONS.tasks.path).save(JSON.stringify(cleaned), {
        contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' }
      });
    }
  }

  const clean = merged.records.map(r => {
    const c = sanitizeRecord(r, COLLECTIONS.timeoff.fields);
    c.id = String(r.id).slice(0, 64);
    return c;
  });
  await bucket.file(COLLECTIONS.timeoff.path).save(JSON.stringify(clean), {
    contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' }
  });

  const meta = {
    syncedAt: new Date().toISOString(),
    fileName: String(opts.fileName || '').slice(0, 200),
    modifiedAt: String(opts.modifiedAt || '').slice(0, 40),
    requests: built.records.length,
    matched: built.records.length - built.unmatched.length,
    unmatched: built.unmatched.length,
    otherClients: parsed.nonGeodis,
    tabs: parsed.sheets.map(s => s.name),
    vanished: merged.vanished.length,
    tasksRaised: raised.length,
    tasksHeld: heldTasks,
    warnings: parsed.warnings.slice(0, 20)
  };
  if (heldTasks) {
    meta.warnings.unshift(heldTasks + ' request(s) left the sheet at once without being processed. ' +
      'That is more than one person moving a row, so no tasks were raised — check whether the file was ' +
      'saved mid-edit. Every record was kept.');
  }
  await bucket.file(ILPTO_META_PATH).save(JSON.stringify(meta), {
    contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' }
  });
  return { ok: true, meta: meta };
}

async function handleIlPto(req, res) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method === 'GET') {
    if (!await requireUser(req, res, 'view')) return;
    res.set('Cache-Control', 'no-cache, max-age=0');
    res.status(200).json({ ok: true, sync: await readJsonFile(ILPTO_META_PATH) });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  if (req.get('x-sync-key') !== SYNC_KEY.value()) { res.status(401).json({ ok: false, error: 'Unauthorized' }); return; }

  const body = req.body || {};
  const b64 = String(body.fileBase64 || body.file || '');
  if (!b64) { res.status(400).json({ ok: false, error: 'Missing fileBase64' }); return; }
  const applied = await applyIlPtoWorkbook(decodeWorkbookBody(b64), {
    fileName: body.fileName, modifiedAt: body.modifiedAt
  });
  if (!applied.ok) { res.status(applied.status || 400).json({ ok: false, error: applied.error }); return; }
  res.status(200).json({ ok: true, sync: applied.meta });
}

/* ---------- the workbook, uploaded from the browser ----------
   The workbook lives in another Microsoft tenant, so no automation here can
   reach it. Somebody uploads it instead, whenever they run attendance, and this
   refreshes everything it carries in one pass: shift tags, open orders, and
   attendance history with its point balances.

   Gated by origin rather than the sync key, because this IS the browser. That is
   the same protection every other browser write uses. */
async function handlePlxUpload(req, res) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }
  if (req.get('origin') !== NOTES_ORIGIN) { res.status(403).json({ ok: false, error: 'Forbidden origin' }); return; }
  if (!await requireUser(req, res, 'import')) return;

  const body = req.body || {};
  if (!body.fileBase64) { res.status(400).json({ ok: false, error: 'Missing fileBase64' }); return; }
  const plxBuffer = Buffer.from(body.fileBase64, 'base64');
  const redbullBuffer = body.redbullBase64 ? Buffer.from(body.redbullBase64, 'base64') : null;

  // Shift tags and open orders, sharing the pipeline the automated push uses.
  const shared = await applyPlxWorkbook(plxBuffer, {
    fileName: body.fileName, modifiedAt: body.modifiedAt, uploadedBy: String(body.uploadedBy || '').slice(0, 80)
  });
  if (!shared.ok) { res.status(shared.status || 400).json({ ok: false, error: shared.error }); return; }

  // Attendance needs the roster to attach anything to a badge.
  let attendance = { skipped: 'no roster snapshot yet' };
  const profiles = await rosterProfiles();
  if (profiles.length) {
    try {
      const byName = Intake.buildNameIndex(profiles, Sched.rosterKey);
      const now = new Date().toISOString();
      const built = AttendanceImport.build(plxBuffer, redbullBuffer, {
        byName, rosterKey: Sched.rosterKey, asOf: now.slice(0, 10),
        plxSource: String(body.fileName || 'PLX - Geodis Spreadsheet.xlsx').slice(0, 200),
        redbullSource: String(body.redbullName || 'Redbull Attendance Tracker').slice(0, 200)
      });
      const existing = await readJsonArray(COLLECTIONS.attendance.path);
      const byId = new Map(existing.map(x => [x.id, x]));
      built.events.forEach(x => byId.set(x.id, Object.assign({}, byId.get(x.id) || {},
        sanitizeRecord(x, COLLECTIONS.attendance.fields), { id: x.id, updatedAt: now })));
      await bucket.file(COLLECTIONS.attendance.path).save(JSON.stringify(Array.from(byId.values())), {
        contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' }
      });
      attendance = built.summary;
    } catch (err) {
      // A bad attendance tab must not lose the shift tags already written.
      attendance = { error: String(err && err.message || err) };
    }
  }

  res.status(200).json({ ok: true, sync: shared.meta, attendance: attendance });
}

/* Asking for a fresh pull. The browser calls this; this calls the Power Automate
   flow that reads SharePoint. The flow URL stays server-side. */
async function handlePlxRefresh(req, res) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }
  if (req.get('origin') !== NOTES_ORIGIN) { res.status(403).json({ ok: false, error: 'Forbidden origin' }); return; }
  if (!await requireUser(req, res, 'import')) return;

  const cfg = await readJsonFile(PLX_CONFIG_PATH);
  const url = String((cfg && cfg.flowUrl) || '');
  if (!url) {
    // Not configured is not an error: the scheduled push still works, so say
    // what is and is not happening rather than failing opaquely.
    res.status(200).json({
      ok: true, triggered: false,
      message: 'No on-demand flow is configured, so this shows the last workbook that was pushed. ' +
        'POST {"flowUrl":"…"} to ?plx=1 with the sync key to let this button ask for a fresh pull.'
    });
    return;
  }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedAt: new Date().toISOString() })
    });
    res.status(200).json({ ok: true, triggered: r.ok, status: r.status });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'Could not reach the refresh flow: ' + String(err.message || err) });
  }
}

/* ---------- who is calling ----------
   Sign-in is email + password via Firebase Auth. The browser sends its ID token
   as `Authorization: Bearer <token>`; this verifies it and pairs it with the
   stored account, which is where the role and market restrictions live.

   ENFORCED. Every browser-facing read and write goes through requireUser()
   below. The origin check stays, but it was never a security control -- it is
   trivially forged by anything that is not a browser, and it says nothing about
   WHO is asking. The token does both. */

/* The domains in force, refreshed from the app config. Cached for the lifetime
   of a warm instance: it is read on nearly every request and changes about once
   a year. Config can only ever WIDEN the built-in list (see auth-core.js), so a
   stale cache cannot lock anybody out, only briefly delay letting somebody new
   in. */
let domainCache = { at: 0, list: null };
const DOMAIN_TTL_MS = 60 * 1000;
async function refreshAllowedDomains() {
  if (domainCache.list && Date.now() - domainCache.at < DOMAIN_TTL_MS) {
    Auth.setAllowedDomains(domainCache.list);
    return;
  }
  let extra = '';
  try {
    const cfg = await readJsonArray(COLLECTIONS.appConfig.path);
    const row = cfg.filter(r => r && r.key === 'allowedDomains')[0];
    extra = row ? String(row.value || '') : '';
  } catch (err) {
    extra = '';                        // unreadable config falls back to built-ins
  }
  domainCache = { at: Date.now(), list: extra };
  Auth.setAllowedDomains(extra);
}

async function identityOf(req) {
  const header = String(req.get('authorization') || '');
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(m[1]);
  } catch (err) {
    return null;                       // an invalid token is an anonymous caller
  }
  await refreshAllowedDomains();
  const email = Auth.normalizeEmail(decoded.email);
  // A verified token from outside the approved domains is still nobody here.
  if (!email || !Auth.domainAllowed(email)) return null;
  const users = await readJsonArray(COLLECTIONS.users.path);
  const rec = users.filter(u => u && Auth.normalizeEmail(u.email) === email)[0];
  /* The STORED record decides. A token proves who somebody is; only the record
     says what they may do, so an account that has never signed in -- and
     therefore has no record -- gets the empty role rather than the default one.
     Otherwise the sign-in endpoint would not be the only place accounts are
     created, and a disabled account could resurrect itself by calling anything
     else first. */
  if (!rec) return null;
  return Auth.normalizeUser(Object.assign({ email: email, uid: decoded.uid, name: decoded.name || '' }, rec));
}

/* The gate. Returns the account, or null having ALREADY answered the request.
   Callers must return immediately on null.

   401 and 403 are kept apart deliberately: 401 means "sign in", which the
   browser can act on by prompting; 403 means "you are signed in and this is not
   yours", which it must not retry. */
async function requireUser(req, res, action) {
  const user = await identityOf(req);
  if (!user) {
    res.status(401).json({ ok: false, error: 'Sign in to use this.', signIn: true });
    return null;
  }
  if (!Auth.can(user, action)) {
    const role = Auth.roleMeta(user.role);
    res.status(403).json({ ok: false, forbidden: true, role: role.key,
      error: !user.enabled ? 'This account has been disabled.'
        : role.rank === 0 ? 'This account has no access yet. An administrator or manager can grant it a role.'
        : 'The ' + role.label + ' role cannot do that.' });
    return null;
  }
  return user;
}

/* ---------- the first administrator ----------
   Somebody has to be able to grant the first role, and nobody can grant a role
   until an administrator exists. Two ways out of that, both narrow:

     1. ADMIN_EMAILS, an environment variable. Any address listed is raised to
        admin on sign-in, every time. This is the one to use on an existing
        deployment, where accounts already exist and none of them is an admin.
     2. An empty account list. The very first person to sign in on a fresh
        deployment becomes the administrator, because otherwise the tool would
        install itself into a state no one can get out of.

   Rule 2 checks the list is EMPTY, not that the user is first alphabetically or
   anything else -- once one account exists the door is shut, so it cannot be
   walked through later by deleting somebody. */
function bootstrapAdmins() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',').map(x => Auth.normalizeEmail(x)).filter(Boolean);
}
function bootstrapRoleFor(email, users) {
  if (bootstrapAdmins().indexOf(Auth.normalizeEmail(email)) !== -1) return 'admin';
  if (!users.length) return 'admin';
  return '';
}

/* First sign-in from an approved domain creates the account, so an admin does
   not have to add everybody by hand. It starts on DEFAULT_ROLE -- Colleague --
   because the domain check has already done the vetting: nobody outside
   geodis.com or employbridge.com can get this far. See auth-core.js. */
async function handleSignIn(req, res) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }
  if (req.get('origin') !== NOTES_ORIGIN) { res.status(403).json({ ok: false, error: 'Forbidden origin' }); return; }

  const header = String(req.get('authorization') || '');
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) { res.status(401).json({ ok: false, error: 'Missing token' }); return; }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(m[1]);
  } catch (err) {
    res.status(401).json({ ok: false, error: 'Invalid token' }); return;
  }
  await refreshAllowedDomains();
  const email = Auth.normalizeEmail(decoded.email);
  if (!Auth.domainAllowed(email)) {
    res.status(403).json({ ok: false, error: 'Only ' + Auth.allowedDomainList().join(' and ') + ' addresses can be used here.' });
    return;
  }

  const users = await readJsonArray(COLLECTIONS.users.path);
  const now = new Date().toISOString();
  const i = users.findIndex(u => u && Auth.normalizeEmail(u.email) === email);
  const seeded = bootstrapRoleFor(email, users);
  let rec;
  if (i === -1) {
    const made = Auth.accountFor(email, decoded.name || req.body && req.body.name || '');
    rec = Object.assign({}, made.user, { uid: decoded.uid, lastSeenAt: now });
    if (seeded) rec.role = seeded;
    users.push(sanitizeRecord(Object.assign({ id: email }, rec), COLLECTIONS.users.fields));
    users[users.length - 1].id = email;
  } else {
    // Never resurrect a disabled account or re-grant a role on sign-in -- with
    // one exception, ADMIN_EMAILS, which exists precisely to reach in and fix a
    // deployment that has locked itself out. It cannot enable a disabled
    // account: taking somebody's access away has to stay final.
    rec = Auth.normalizeUser(users[i]);
    const forced = bootstrapAdmins().indexOf(email) !== -1 && rec.enabled;
    users[i] = Object.assign({}, users[i], { uid: decoded.uid, lastSeenAt: now, id: email },
      forced ? { role: 'admin' } : {});
    if (forced) rec.role = 'admin';
    rec.uid = decoded.uid;
    rec.lastSeenAt = now;
  }
  await bucket.file(COLLECTIONS.users.path).save(JSON.stringify(users), {
    contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' }
  });
  res.status(200).json({ ok: true, user: Auth.normalizeUser(rec) });
}

/* ---------- the reconciliation snapshot ----------
   The roster: every active assignment, with names, badges and employee ids. It
   used to be fetched straight from a public Storage URL, which meant the front
   door could be locked and the window left open -- anybody with the link had the
   whole roster without signing in.

   It is served from here now, behind the same gate as everything else. The
   Storage rule for `snapshots/` must be flipped to `allow read: if false` for
   this to be worth anything; see SETUP.md. */
async function handleSnapshot(req, res) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'GET only' }); return; }
  const actor = await requireUser(req, res, 'view');
  if (!actor) return;
  res.set('Cache-Control', 'no-cache, max-age=0');
  try {
    const [buf] = await bucket.file(SNAPSHOT_PATH).download();
    const snapshot = JSON.parse(buf.toString());
    res.status(200).json(MarketAccess.filterSnapshot(actor, snapshot));
  } catch (err) {
    if (err && err.code === 404) {
      // No snapshot yet is a normal state on a new deployment, not a failure.
      res.status(200).json({ ok: true, updatedAt: null, counts: {}, records: [] });
      return;
    }
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
}

function parseToState(buffer, side) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  return Core.buildState(aoa, side);
}

exports.syncReport = onRequest({ region: 'us-central1', secrets: [SYNC_KEY] }, async (req, res) => {
  try {
    // Shared browser stores (notes + status overrides). Separate from the sync path.
    if (req.query.notes !== undefined) {
      await handleKv(req, res, { path: NOTES_PATH, field: 'note', responseKey: 'notes', maxLen: 1000 });
      return;
    }
    if (req.query.overrides !== undefined) {
      await handleKv(req, res, { path: OVERRIDES_PATH, field: 'action', responseKey: 'overrides', maxLen: 40, allowed: Object.keys(Core.ACTIONS) });
      return;
    }
    if (req.query.ptoIntake !== undefined) { await handlePtoIntake(req, res); return; }
    if (req.query.transitionImport !== undefined) { await handleTransitionImport(req, res); return; }
    if (req.query.attendanceImport !== undefined) { await handleAttendanceImport(req, res); return; }
    if (req.query.reqSync !== undefined) { await handleReqSync(req, res); return; }
    if (req.query.discrepancyIntake !== undefined) { await handleDiscrepancyIntake(req, res); return; }
    if (req.query.payroll !== undefined) { await handlePayroll(req, res); return; }
    if (req.query.signIn !== undefined) { await handleSignIn(req, res); return; }
    if (req.query.snapshot !== undefined) { await handleSnapshot(req, res); return; }
    if (req.query.plxUpload !== undefined) { await handlePlxUpload(req, res); return; }
    if (req.query.plx !== undefined) { await handlePlx(req, res); return; }
    if (req.query.plxRefresh !== undefined) { await handlePlxRefresh(req, res); return; }
    if (req.query.ilPto !== undefined) { await handleIlPto(req, res); return; }
    if (req.query.schedule !== undefined) { await handleSchedule(req, res); return; }
    if (req.query.coverage !== undefined) { await handleCoverage(req, res); return; }
    // Suite collections: ?attendance=1, ?timeoff=1, ?requisitions=1, ?performance=1
    const collectionKey = Object.keys(COLLECTIONS).find(k => req.query[k] !== undefined);
    if (collectionKey) {
      await handleCollection(req, res, COLLECTIONS[collectionKey]);
      return;
    }

    if (req.method !== 'POST') { res.status(405).send('POST only'); return; }

    const key = req.get('x-sync-key');
    const expected = SYNC_KEY.value();
    if (!expected || key !== expected) { res.status(401).send('Unauthorized'); return; }

    const type = String(req.query.type || '').toLowerCase();
    if (type !== 'beeline' && type !== 'crm' && type !== 'rcended') {
      res.status(400).send('Missing or invalid ?type= (expected "beeline", "crm", or "rcended")');
      return;
    }
    const b64 = req.body && req.body.fileBase64;
    if (!b64) { res.status(400).send('Missing fileBase64 in request body'); return; }

    const buffer = unwrapDoubleBase64(Buffer.from(b64, 'base64'));

    // Guard: reject anything that still isn't a valid .xlsx (e.g. the tiny ASCII
    // skeleton PA produces on a truly mangled upload) BEFORE overwriting the last-good
    // file, so one bad upload can't wipe good data and the failure is visible.
    if (!isXlsxZip(buffer)) {
      res.status(400).json({ ok: false, error: 'Uploaded ' + type + ' file is not a valid .xlsx (got ' + buffer.length + ' bytes). It was not saved; the previous file is kept.' });
      return;
    }

    // Save the raw file that just arrived (always overwrite "latest" for that type)
    await bucket.file(RAW_PATH[type]).save(buffer, { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

    // Gather all inputs: beeline + crm are REQUIRED to compute; the RC "ended"
    // report is OPTIONAL enrichment. Use the file we just saved for its own type,
    // and read the others from storage.
    const beeBuf = type === 'beeline' ? buffer : await readRawFile('beeline');
    const crmBuf = type === 'crm' ? buffer : await readRawFile('crm');
    const endedBuf = type === 'rcended' ? buffer : await readRawFile('rcended');

    if (!beeBuf || !crmBuf) {
      const missing = !beeBuf ? 'beeline' : 'crm';
      res.status(200).json({ ok: true, computed: false, message: 'Saved ' + type + '. Waiting on ' + missing + ' before computing a snapshot.' });
      return;
    }

    const beeSt = parseToState(beeBuf, 'beeline');
    const crmSt = parseToState(crmBuf, 'crm');
    const endedSt = endedBuf ? parseToState(endedBuf, 'crm') : null;
    // Include every market in the snapshot so one file serves all branches; each
    // branch filters to its own market client-side (null = no region pre-filter).
    beeSt.selectedRegions = null;

    const { records, counts } = Core.reconcile(beeSt, crmSt, endedSt);

    // Flatten to plain, render-ready values (dates as formatted strings) so the
    // browser can display the snapshot without re-running any date parsing.
    const snapshot = {
      updatedAt: new Date().toISOString(),
      counts: counts,
      records: records.map(r => ({
        badge: r.badge,
        empNumber: r.empNumber || '',
        contactId: r.contactId || '',
        assignmentId: r.assignmentId || '',
        person: r.person,
        altName: r.altName,
        action: r.action,
        actionLabel: Core.ACTIONS[r.action].label,
        reason: r.reason,
        market: r.market,
        marketVerified: r.marketVerified,
        marketRaw: r.marketRaw || '',
        newBadge: r.newBadge || null,
        crmStart: Core.fmtDate(r.crmStart),
        beeStart: Core.fmtDate(r.beeStart),
        endDate: Core.fmtDate(r.endDate),
        endReason: r.endReason || '',
        dup: r.dup
      }))
    };

    await bucket.file(SNAPSHOT_PATH).save(JSON.stringify(snapshot), {
      contentType: 'application/json',
      metadata: { cacheControl: 'no-cache, max-age=0' }
    });

    res.status(200).json({ ok: true, computed: true, counts: counts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
});
