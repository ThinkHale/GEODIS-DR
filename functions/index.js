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
                  fields: { badge: 'str', type: 'str', start: 'str', end: 'str', hours: 'num', status: 'str', notes: 'str' } },
  requisitions: { path: 'requisitions/requisitions.json', responseKey: 'requisitions',
                  fields: { title: 'str', department: 'str', shift: 'str', market: 'str', openings: 'num',
                            filled: 'num', priority: 'str', status: 'str', due: 'str', notes: 'str' } },
  performance:  { path: 'performance/metrics.json',      responseKey: 'performance',
                  fields: { badge: 'str', period: 'str', quality: 'num', productivity: 'num', safety: 'num',
                            units: 'num', hours: 'num', notes: 'str' } }
};
const MAX_COLLECTION_RECORDS = 20000;
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
      list.splice(idx, 1);
    } else {
      if (idx === -1 && list.length >= MAX_COLLECTION_RECORDS) {
        res.status(400).json({ ok: false, error: 'Collection is full' }); return;
      }
      const rec = sanitizeRecord(body, opts.fields);
      rec.id = id;
      rec.updatedAt = now;
      if (idx === -1) list.push(rec);
      else list[idx] = Object.assign({}, list[idx], rec);
    }
  }

  await bucket.file(opts.path).save(JSON.stringify(list), {
    contentType: 'application/json',
    metadata: { cacheControl: 'no-cache, max-age=0' }
  });
  res.status(200).json({ ok: true, count: list.length });
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
