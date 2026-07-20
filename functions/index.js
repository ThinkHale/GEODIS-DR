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

const RAW_PATH = { beeline: 'raw/beeline-latest.xlsx', crm: 'raw/crm-latest.xlsx' };
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
    if (type !== 'beeline' && type !== 'crm') {
      res.status(400).send('Missing or invalid ?type= (expected "beeline" or "crm")');
      return;
    }
    const b64 = req.body && req.body.fileBase64;
    if (!b64) { res.status(400).send('Missing fileBase64 in request body'); return; }

    // Save the raw file that just arrived (always overwrite "latest" for that type)
    const buffer = Buffer.from(b64, 'base64');
    await bucket.file(RAW_PATH[type]).save(buffer, { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

    // Pull the latest known copy of BOTH files (the one we just saved, plus whatever
    // we already had for the other type) and recompute if we have both.
    const otherType = type === 'beeline' ? 'crm' : 'beeline';
    const otherBuf = await readRawFile(otherType);

    if (!otherBuf) {
      res.status(200).json({ ok: true, computed: false, message: 'Saved ' + type + '. Waiting on ' + otherType + ' before computing a snapshot.' });
      return;
    }

    const beeBuf = type === 'beeline' ? buffer : otherBuf;
    const crmBuf = type === 'crm' ? buffer : otherBuf;

    const beeSt = parseToState(beeBuf, 'beeline');
    const crmSt = parseToState(crmBuf, 'crm');
    beeSt.selectedRegions = Core.autoSelectRegions(beeSt, crmSt);

    const { records, counts } = Core.reconcile(beeSt, crmSt);

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
