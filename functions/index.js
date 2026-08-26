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
const TransitionPto = require('./transition-pto.js');
const ShiftKey = require('./shift-key.js');

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
const SNAPSHOT_PATH = 'snapshots/latest.json';
const NOTES_PATH = 'notes/notes.json';
const OVERRIDES_PATH = 'overrides/overrides.json';   // badge -> manual status override
// Suite collections. Unlike the badge-keyed stores above these hold a list of
// records, because a person has many attendance events and many time-off
// requests, and a requisition is not tied to a badge at all.
const COLLECTIONS = {
  attendance:   { path: 'attendance/events.json',        responseKey: 'attendance',
                  fields: { badge: 'str', date: 'str', type: 'str', minutes: 'num', points: 'num', notes: 'str' } },
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
  requisitions: { path: 'requisitions/requisitions.json', responseKey: 'requisitions',
                  fields: { title: 'str', department: 'str', shift: 'str', market: 'str', openings: 'num',
                            filled: 'num', priority: 'str', status: 'str', due: 'str', notes: 'str',
                            building: 'str', reportTo: 'str', source: 'str' } },
  // Shift tags cross-referenced from the PLX workbook. Keyed by WFM EID where
  // there is one, name otherwise -- see shift-key.js.
  shifts:       { path: 'shifts/assignments.json',       responseKey: 'shifts',
                  fields: { eid: 'str', nameKey: 'str', name: 'str', shift: 'str', building: 'str',
                            dept: 'str', hours: 'str', badge: 'str', source: 'str' } },
  // Payroll discrepancies raised on the GEODIS Payroll Discrepancy Form.
  discrepancies:{ path: 'payroll/discrepancies.json',    responseKey: 'discrepancies',
                  fields: { badge: 'str', name: 'str', location: 'str', date: 'str', weekEnding: 'str',
                            details: 'str', status: 'str', source: 'str', submittedAt: 'str',
                            statusUpdatedAt: 'str', statusUpdatedBy: 'str', connectedBy: 'str',
                            connectedAt: 'str', notes: 'str', statusHistory: 'log' } },
  performance:  { path: 'performance/metrics.json',      responseKey: 'performance',
                  fields: { badge: 'str', period: 'str', quality: 'num', productivity: 'num', safety: 'num',
                            units: 'num', hours: 'num', notes: 'str' } }
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
   Read from the browser (public), written from the browser. There is no per-user
   auth (the whole tool is unauthenticated), so writes are gated only by CORS +
   an Origin check + payload limits. Fine for internal, low-sensitivity data;
   harden with Firebase Auth if that ever changes. */
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
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '3600');
}
// Generic badge -> { <field>, updatedAt } store. Empty value deletes the entry.
// opts: { path, field, responseKey, maxLen, allowed? (whitelist of valid values) }
async function handleKv(req, res, opts) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method === 'GET') {
    res.set('Cache-Control', 'no-cache, max-age=0');
    res.status(200).json({ ok: true, [opts.responseKey]: await readJsonFile(opts.path) });
    return;
  }
  if (req.method === 'POST') {
    if (req.get('origin') !== NOTES_ORIGIN) { res.status(403).json({ ok: false, error: 'Forbidden origin' }); return; }
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
async function handleCollection(req, res, opts) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method === 'GET') {
    res.set('Cache-Control', 'no-cache, max-age=0');
    res.status(200).json({ ok: true, [opts.responseKey]: await readJsonArray(opts.path) });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  if (req.get('origin') !== NOTES_ORIGIN) { res.status(403).json({ ok: false, error: 'Forbidden origin' }); return; }

  const body = req.body || {};
  const now = new Date().toISOString();
  let list;
  let associatePto;

  if (Array.isArray(body.records)) {
    // Bulk replace, used by report imports.
    if (body.records.length > MAX_COLLECTION_RECORDS) {
      res.status(400).json({ ok: false, error: 'Too many records' }); return;
    }
    list = body.records.map((raw, i) => {
      const rec = sanitizeRecord(raw || {}, opts.fields);
      rec.id = raw && raw.id != null ? String(raw.id).slice(0, 64) : opts.responseKey + '-' + Date.now() + '-' + i;
      rec.updatedAt = now;
      return rec;
    });
  } else {
    const id = body.id != null ? String(body.id).trim() : '';
    if (!id || id.length > 64) { res.status(400).json({ ok: false, error: 'Missing/invalid id' }); return; }
    list = await readJsonArray(opts.path);
    const idx = list.findIndex(x => x && x.id === id);
    if (body._delete) {
      if (idx === -1) { res.status(200).json({ ok: true, deleted: false }); return; }
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
  res.status(200).json({ ok: true, count: list.length,
    record: body.id ? list.find(x => x && x.id === String(body.id).trim()) || null : null,
    associatePto: associatePto || undefined });
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

async function listDateKeys(dir) {
  const [files] = await bucket.getFiles({ prefix: dir + '/' });
  return files
    .map(f => (f.name.split('/').pop() || '').replace(/\.json$/, ''))
    .filter(k => dateKeyOf(k))
    .sort();
}

/* GET  ?schedule=1                     -> { periods: [...] }
   GET  ?schedule=1&period=YYYY-MM-DD   -> the stored week
   POST ?schedule=1&period=YYYY-MM-DD   -> replace that week  */
async function handleSchedule(req, res) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  const period = dateKeyOf(req.query.period);

  if (req.method === 'GET') {
    res.set('Cache-Control', 'no-cache, max-age=0');
    if (!period) { res.status(200).json({ ok: true, periods: await listDateKeys(SCHEDULE_DIR) }); return; }
    res.status(200).json({ ok: true, schedule: await readJsonFile(SCHEDULE_DIR + '/' + period + '.json') });
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
  const doc = {
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
  await bucket.file(SCHEDULE_DIR + '/' + period + '.json').save(JSON.stringify(doc), {
    contentType: 'application/json',
    metadata: { cacheControl: 'no-cache, max-age=0' }
  });
  res.status(200).json({ ok: true, period: period, people: doc.people.length });
}

/* GET  ?coverage=1                   -> { dates: [...] }
   GET  ?coverage=1&date=YYYY-MM-DD   -> that day's checks + documentation
   POST ?coverage=1&date=...  { check }     -> append one on-premise check
   POST ?coverage=1&date=...  { document }  -> document one person's absence  */
async function handleCoverage(req, res) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  const date = dateKeyOf(req.query.date);

  if (req.method === 'GET') {
    res.set('Cache-Control', 'no-cache, max-age=0');
    if (!date) { res.status(200).json({ ok: true, dates: await listDateKeys(COVERAGE_DIR) }); return; }
    res.status(200).json({ ok: true, coverage: await readJsonFile(COVERAGE_DIR + '/' + date + '.json') });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  if (req.get('origin') !== NOTES_ORIGIN) { res.status(403).json({ ok: false, error: 'Forbidden origin' }); return; }
  if (!date) { res.status(400).json({ ok: false, error: 'Missing/invalid date' }); return; }

  const path = COVERAGE_DIR + '/' + date + '.json';
  const existing = await readJsonFile(path);
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
    if (i === -1) doc.checks.push(check); else doc.checks[i] = check;
    doc.checks.sort((a, b) => String(a.asOf || '').localeCompare(String(b.asOf || '')));
    if (doc.checks.length > MAX_CHECKS_PER_DAY) doc.checks = doc.checks.slice(-MAX_CHECKS_PER_DAY);
  } else if (body.document) {
    const dRec = body.document;
    const key = str(dRec.key, 140);
    if (!key) { res.status(400).json({ ok: false, error: 'Missing document key' }); return; }
    // An empty reason clears the entry rather than storing a blank note.
    if (!str(dRec.reason, 500).trim() && !str(dRec.disposition, 60).trim()) {
      delete doc.documented[key];
    } else {
      doc.documented[key] = {
        reason: str(dRec.reason, 500),
        disposition: str(dRec.disposition, 60),
        name: str(dRec.name, 120),
        badge: str(dRec.badge, 64),
        updatedAt: new Date().toISOString()
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
  res.status(200).json({ ok: true, date: date, checks: doc.checks.length });
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

   Writing hours needs the sync key, because that is an automation. Recording a
   close date is a person in the browser, so it takes the origin check instead. */
async function handlePayroll(req, res) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  const week = dateKeyOf(req.query.week);

  if (req.method === 'GET') {
    res.set('Cache-Control', 'no-cache, max-age=0');
    if (!week) { res.status(200).json({ ok: true, periods: await listDateKeys(PAYROLL_DIR) }); return; }
    res.status(200).json({ ok: true, period: await readJsonFile(PAYROLL_DIR + '/' + week + '.json') });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  if (!week) { res.status(400).json({ ok: false, error: 'Missing/invalid week' }); return; }

  const body = req.body || {};
  const path = PAYROLL_DIR + '/' + week + '.json';
  const existing = await readJsonFile(path);
  const period = {
    weekEnding: week,
    closesAt: existing.closesAt || '',
    snapshots: Array.isArray(existing.snapshots) ? existing.snapshots : [],
    changes: Array.isArray(existing.changes) ? existing.changes : [],
    updatedAt: new Date().toISOString()
  };

  if (body.closesAt !== undefined) {
    // A person setting the cutoff, from the browser.
    if (req.get('origin') !== NOTES_ORIGIN) { res.status(403).json({ ok: false, error: 'Forbidden origin' }); return; }
    period.closesAt = String(body.closesAt || '').slice(0, 40);
  } else if (Array.isArray(body.rows)) {
    // An automation posting a pull of the hours report.
    if (req.get('x-sync-key') !== SYNC_KEY.value()) { res.status(401).json({ ok: false, error: 'Unauthorized' }); return; }
    if (body.rows.length > MAX_HOURS_ROWS) { res.status(400).json({ ok: false, error: 'Too many rows' }); return; }
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
  } else {
    res.status(400).json({ ok: false, error: 'Expected rows or closesAt' });
    return;
  }

  await bucket.file(path).save(JSON.stringify(period), {
    contentType: 'application/json',
    metadata: { cacheControl: 'no-cache, max-age=0' }
  });
  res.status(200).json({ ok: true, weekEnding: week, closesAt: period.closesAt });
}

/* ---------- the live PLX workbook ----------
   The browser cannot read SharePoint: it is a different origin and needs
   Microsoft 365 auth, and this tool has none. So Power Automate reads the
   workbook and posts it here, exactly as it already does for the daily reports.

   Two things come out of it: the shift tag for every associate, and the open
   orders on the Beeline Reqs tab. Both are merged over what is already stored --
   a refresh must never wipe something a person filled in by hand. */
async function handlePlx(req, res) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  if (req.method === 'GET') {
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
  let wb;
  try {
    wb = XLSX.read(Buffer.from(b64, 'base64'), { type: 'buffer' });
  } catch (err) {
    res.status(400).json({ ok: false, error: 'Could not read the workbook: ' + err.message });
    return;
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
    res.status(400).json({
      ok: false,
      error: 'That file has none of the expected tabs (Geodis Key, "<site> - HC", Beeline Reqs). ' +
        'Tabs found: ' + wb.SheetNames.slice(0, 10).join(', ')
    });
    return;
  }
  const warnings = [];

  // --- shift tags, from the Key + HC tabs ---
  const keySheet = sheets.filter(x => ShiftKey.KEY_SHEET.test(x.name))[0];
  const key = keySheet ? ShiftKey.parseShiftKey(keySheet.aoa) : null;
  if (!key) warnings.push('No "Geodis Key" tab was found, so shift hours are unknown.');
  else warnings.push(...key.warnings);
  const hc = ShiftKey.parseHeadcount(sheets, Sched.rosterKey);
  warnings.push(...hc.warnings, ...ShiftKey.validateAgainstKey(hc, key));
  const shiftRecords = ShiftKey.toShiftRecords(hc, key);
  if (shiftRecords.length) {
    /* A shift set by hand in the suite is not in the workbook, so replacing the
       collection wholesale would erase it on every push -- and this runs on a
       schedule. Hand-set tags are kept, EXCEPT where the workbook now covers the
       same person: two records for one name would poison each other in
       buildProfiles and leave them with no shift at all. The workbook is the
       system of record, so it wins, and the ones it supersedes are named. */
    const fromBook = shiftRecords.map(r => Object.assign(
      sanitizeRecord(r, COLLECTIONS.shifts.fields),
      { id: String(r.id).slice(0, 64), updatedAt: new Date().toISOString() }
    ));
    const bookNames = new Set(fromBook.map(r => r.nameKey).filter(Boolean));
    const existingShifts = await readJsonArray(COLLECTIONS.shifts.path);
    const superseded = [];
    const kept = existingShifts.filter(r => {
      if (!r || r.source === 'PLX workbook') return false;   // replaced by this push
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

  // --- open orders, from the Beeline Reqs tab ---
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
      // The sheet does not track how many are filled or where a req stands, so
      // those are whatever somebody last set here.
      clean.filled = prior && Number.isFinite(Number(prior.filled)) ? Number(prior.filled) : 0;
      const openings = Number(clean.openings) || 0;
      clean.status = prior && prior.status ? prior.status
        : (openings > 0 && clean.filled >= openings ? 'Filled' : 'Open');
      byId.set(clean.id, Object.assign({}, prior || {}, clean));
    });
    // A req that has left the sheet has been closed out there. Mark it rather
    // than deleting it, so its history and anything filled against it survive.
    const live = new Set(incoming.map(r => r.id));
    byId.forEach((rec, id) => {
      if (rec.source === 'PLX workbook' && !live.has(id) && rec.status !== 'Closed') {
        byId.set(id, Object.assign({}, rec, { status: 'Closed', updatedAt: new Date().toISOString() }));
      }
    });
    const merged = Array.from(byId.values());
    reqCount = incoming.length;
    await bucket.file(COLLECTIONS.requisitions.path).save(JSON.stringify(merged), {
      contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' }
    });
  }

  const meta = {
    syncedAt: new Date().toISOString(),
    fileName: String(body.fileName || '').slice(0, 300),
    modifiedAt: String(body.modifiedAt || '').slice(0, 40),
    shiftTags: shiftRecords.length,
    sites: hc.sheets.length,
    openOrders: reqCount,
    warnings: warnings.slice(0, 20)
  };
  await bucket.file(PLX_META_PATH).save(JSON.stringify(meta), {
    contentType: 'application/json', metadata: { cacheControl: 'no-cache, max-age=0' }
  });
  res.status(200).json({ ok: true, sync: meta });
}

/* Asking for a fresh pull. The browser calls this; this calls the Power Automate
   flow that reads SharePoint. The flow URL stays server-side. */
async function handlePlxRefresh(req, res) {
  setKvCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }
  if (req.get('origin') !== NOTES_ORIGIN) { res.status(403).json({ ok: false, error: 'Forbidden origin' }); return; }

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
    if (req.query.discrepancyIntake !== undefined) { await handleDiscrepancyIntake(req, res); return; }
    if (req.query.payroll !== undefined) { await handlePayroll(req, res); return; }
    if (req.query.plx !== undefined) { await handlePlx(req, res); return; }
    if (req.query.plxRefresh !== undefined) { await handlePlxRefresh(req, res); return; }
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

    let buffer = Buffer.from(b64, 'base64');

    // A real .xlsx is a ZIP starting with "PK\x03\x04".
    const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

    // Power Automate's "Get Attachment (V2)" often DOUBLE-base64-encodes contentBytes:
    // one decode yields the ASCII base64 text of the real file (starts with "UEsD").
    // If the first decode isn't a ZIP but looks like base64 text, unwrap one more layer.
    if (!isZip(buffer)) {
      const asText = buffer.toString('latin1');
      if (asText.length >= 8 && /^[A-Za-z0-9+/=\s]+$/.test(asText.slice(0, 200))) {
        const inner = Buffer.from(asText, 'base64');
        if (isZip(inner)) buffer = inner;
      }
    }

    // Guard: reject anything that still isn't a valid .xlsx (e.g. the tiny ASCII
    // skeleton PA produces on a truly mangled upload) BEFORE overwriting the last-good
    // file, so one bad upload can't wipe good data and the failure is visible.
    if (!isZip(buffer)) {
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
