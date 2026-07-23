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

async function readRawFile(type) {
  try {
    const [buf] = await bucket.file(RAW_PATH[type]).download();
    return buf;
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
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

    const buffer = Buffer.from(b64, 'base64');

    // Guard: a real .xlsx is a ZIP and must start with "PK\x03\x04". Power Automate
    // intermittently mangles large attachments into a tiny ASCII skeleton; reject
    // those BEFORE overwriting the last-good file, so one bad upload can't wipe good
    // data and the failure is visible to the caller instead of silently breaking.
    const isXlsx = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
    if (!isXlsx) {
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
