/* GEODIS Management Suite -- open requisitions and the candidates on them.
 *
 * Two Beeline exports land by email each morning:
 *
 *   GEODIS Open Reqs            req-level: openings, the submitted/declined/
 *                               offered/hired pipeline, hiring manager, profit
 *                               centre (which is where the market comes from)
 *   Candidate Status per Req    candidate-level: who is attached to each req,
 *                               their Beeline id, the job position and location
 *
 * BOTH files carry one row per (req x candidate), with the req-level columns
 * repeated down every row of the same req. So neither file's row count is a
 * requisition count -- 633 rows is 110 reqs. Reqs are keyed by Request-ID and
 * deduped; candidates are the rows that actually name somebody.
 *
 * The Candidate Status export carries TWO status columns and they mean different
 * things. "Status" is the REQUEST's status, identical to "Request Status" on every
 * req in the reqs export. "Internal Status" is the per-candidate one -- Offer
 * Confirmed, Offer Pending, Rejected, Pending -- and it is what says where an
 * individual stands.
 *
 * With Internal Status present the pipeline counts no longer have to come from the
 * reqs export: on every req where the two files were pulled close enough together
 * to agree at all, Offer Confirmed equals Candidates Hired and Rejected equals
 * Candidates Declined, exactly. Candidates Offered is NOT reliably derivable
 * (no candidate-status combination reproduces it on more than 104 of 108 reqs), so
 * it is left null when the reqs export is absent rather than approximated -- the
 * per-candidate breakdown says more than the aggregate did anyway.
 *
 * The two files are parsed by the SAME function. It reads whichever columns are
 * present and records what it found, so this works with the two exports today
 * and with a single combined export later, without a second code path.
 *
 * No DOM access, the same arrangement reconcile-core.js and schedule-core.js
 * have, so a scheduled Cloud Function can reuse it when these are automated.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./reconcile-core.js'));
  } else {
    root.ReqsCore = factory(root.ReconcileCore);
  }
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  /* ---------- column detection ----------
     Matched by header text rather than position, so a re-ordered or widened
     export keeps working -- and so one combined file is read by the same code. */
  var COLS = {
    /* Hyphen, underscore or space, and not only at the start of the cell -- a
       header of "Beeline Request-ID" is the same column as "Request ID" and used
       to miss both patterns: the anchored one because of the prefix, the loose
       one because \s does not match a hyphen. */
    reqId:      [/^request[\s\-_]*id$/i, /request[\s\-_]*id/i, /^req[\s\-_]*id$/i],
    status:     [/^request status$/i, /^status$/i],
    hiringMgr:  [/hiring manager/i],
    // The reqs export calls it "Start Date - Start"; the candidate export added it
    // as a bare "Date". Both are the req's start date.
    startDate:  [/start date/i, /^start$/i, /^date$/i],
    requested:  [/candidates requested/i, /^requested$/i, /openings/i],
    submitted:  [/candidates submitted/i, /^submitted$/i],
    declined:   [/candidates declined/i, /^declined$/i],
    offered:    [/candidates offered/i, /^offered$/i],
    hired:      [/candidates hired/i, /^hired$/i],
    profitCtr:  [/bill to profit center/i, /profit center/i, /profit centre/i],
    reportsTo:  [/reports to/i],
    candidate:  [/^candidate$/i, /candidate name/i],
    // Per-candidate pipeline status. Distinct from "Status", which is the req's.
    candStatus: [/internal status/i, /candidate status/i],
    jobPosition:[/job position/i, /^position$/i, /^job$/i],
    location:   [/location name/i, /^location$/i],
    beelineId:  [/beeline id/i],
    externalId: [/external id/i],
    // The Candidate Status export's bare "Name" column: the supervisor the
    // position reports to (confirmed with the site). It is req-level and is NOT
    // the hiring manager -- it differs from it on 17 of 110 reqs. It is parsed
    // separately from the reqs export's own sparse "Reports To" column and the
    // two are resolved in finish(), so neither file's load order can change which
    // supervisor a req ends up showing.
    contact:    [/^name$/i]
  };

  /* ---------- candidate status ----------
     The stage each Internal Status value puts somebody at. An unrecognised value
     is kept and counted under 'other' rather than dropped or forced into a bucket:
     a status nobody has seen before is a thing to look at, not to guess about. */
  var CANDIDATE_STATUS = {
    'offer confirmed': { label: 'Offer confirmed', stage: 'hired',    tone: 'ok' },
    'offer pending':   { label: 'Offer pending',   stage: 'offered',  tone: 'warn' },
    'rejected':        { label: 'Rejected',        stage: 'declined', tone: 'bad' },
    'pending':         { label: 'Pending',         stage: 'review',   tone: 'info' }
  };
  var STAGE_ORDER = ['hired', 'offered', 'review', 'declined', 'other'];
  function statusMeta(v) {
    var key = String(v == null ? '' : v).trim().toLowerCase();
    if (!key) return { label: '', stage: '', tone: '' };
    return CANDIDATE_STATUS[key] ||
      { label: String(v).trim(), stage: 'other', tone: '', unknown: true };
  }

  /* ---------- site number -> market ----------
     The profit centre is the direct source of a market, but the daily candidate
     export does not carry it. It does carry the work location, whose leading
     number is the site: "4805 - 2202 Perimeter Rd,,Auburn,WA,US" is site 4805.

     Every one of the 29 sites observed maps to exactly one market, and the profit
     centre's own tail begins with that same site number on every req -- so the
     mapping is a fact the exports already state, and learnSiteMarkets() reads it
     off any export that still carries the profit centre. It is kept in the
     Locations admin list (code -> market), which is where a site number already
     gets a name and a market, rather than in a table inside this file that only
     an engineer could correct. */
  function siteMarketIndex(locations) {
    var map = new Map();
    (locations || []).forEach(function (l) {
      var code = str(l.code), market = str(l.market);
      if (code && market) map.set(code, market);
    });
    return map;
  }

  /* site -> market pairs the data states outright, for seeding that admin list.
     Takes MERGED requisitions, not raw sources: the profit centre arrives in the
     reqs export and the work location in the candidate export, so no single file
     states both and only the merged req knows the pair. */
  function learnSiteMarkets(reqs) {
    var byCode = new Map();
    (reqs || []).forEach(function (r) {
      var market = r.market || marketOf(r.profitCenter);
      // Only a market read off the profit centre teaches anything; one already
      // derived from the site number would just be teaching itself.
      if (r.marketFrom === 'site') market = marketOf(r.profitCenter);
      var loc = parseLocation(r.location);
      var site = loc.site;
      if (!site || !market) return;
      var prior = byCode.get(site);
      // A site two rows disagree about is not a fact; leave it to a person.
      if (prior && prior.market !== market) { prior.conflict = true; return; }
      // The city is what a site is called in conversation -- 1544 is Joliet -- so
      // it travels with the pair and seeds the Locations list's name.
      if (!prior) byCode.set(site, { code: site, market: market, city: loc.city, state: loc.state });
    });
    var out = [];
    byCode.forEach(function (v) { if (!v.conflict) out.push(v); });
    return out.sort(function (a, b) { return a.code.localeCompare(b.code); });
  }

  /* Both sources name the same real requisition by different strings: Beeline
     writes "110642-1", the PLX workbook writes "110642". The suffix has been 1 on
     every req observed, and the base number is unique, so the base is the key --
     and it is the SAME key the workbook sync already writes (REQ-<number>), so a
     req imported from both lands on one record instead of two. */
  function reqKey(requestId) {
    var id = String(requestId == null ? '' : requestId).trim();
    if (!id) return '';
    // Only a numeric id with a numeric suffix is a Beeline request number. Anything
    // else is kept whole: splitting on the first dash would collapse unrelated ids
    // that merely share a prefix onto one key, which silently merges two requests.
    var m = id.match(/^(\d+)-\d+$/);
    return 'REQ-' + (m ? m[1] : id);
  }

  function pickCol(headers, patterns) {
    for (var i = 0; i < patterns.length; i++) {
      var idx = headers.findIndex(function (h) { return patterns[i].test(h); });
      if (idx !== -1) return idx;
    }
    return -1;
  }

  /* ---------- values ---------- */
  function str(v) { return v == null ? '' : String(v).trim(); }

  // A count column that is absent is not zero. null means "this export does not
  // say", and every derived figure guards on it rather than rendering a 0 that
  // reads as a real measurement.
  function count(v) {
    var s = str(v);
    if (s === '') return null;
    var n = Number(s.replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }

  /* Beeline writes the start date as 04/27/2026, but a CSV opened through a
     spreadsheet reader can come back as 4/27/26 or as a Date. All three mean the
     same day, so all three normalise to one ISO string. */
  function pad(n) { return String(n).padStart(2, '0'); }
  function isoDate(v) {
    if (v instanceof Date && !isNaN(v.getTime())) {
      return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
    }
    var s = str(v);
    if (!s) return '';
    var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (!m) return '';
    var y = Number(m[3]);
    if (y < 100) y += 2000;   // a two-digit year in a staffing report is this century
    return y + '-' + pad(m[1]) + '-' + pad(m[2]);
  }

  /* "LLC;North East;Central PA;3902-18067" -> market "Central PA".
     regionOf() in reconcile-core.js is the one implementation of this rule; the
     roster's markets come from the same column, so reqs and associates land in
     the same market vocabulary and the suite's market picker filters both. */
  function marketOf(profitCenter) {
    var s = str(profitCenter);
    if (!s) return '';
    return Core && Core.regionOf ? Core.regionOf(s) : s;
  }

  /* "4805 - 2202 Perimeter Rd,,Auburn,WA,US" -> site 4805, Auburn, WA.
     The second field is empty in every observed row (an address line 2), so the
     city and state are taken from the END rather than by fixed index. */
  function parseLocation(v) {
    var s = str(v);
    var out = { raw: s, site: '', address: '', city: '', state: '', country: '' };
    if (!s) return out;
    var parts = s.split(',').map(function (p) { return p.trim(); });
    var head = parts[0] || '';
    var m = head.match(/^(\d+)\s*-\s*(.*)$/);
    if (m) { out.site = m[1]; out.address = m[2]; } else { out.address = head; }
    if (parts.length >= 3) {
      out.country = parts[parts.length - 1];
      out.state = parts[parts.length - 2];
      out.city = parts[parts.length - 3];
    }
    return out;
  }

  function blank(v) { return v === '' || v === null || v === undefined; }

  /* How far down to look for the header. A few of these exports carry a title
     and a blank line or two above it; 25 was a guess and costs nothing to
     raise, since the scan stops the moment it finds the column. */
  var HEADER_SCAN_ROWS = 40;

  // The first row with anything in it -- the best guess at what the exporter
  // thinks its headers are.
  function firstPopulatedRow(rows) {
    for (var i = 0; i < Math.min((rows || []).length, HEADER_SCAN_ROWS); i++) {
      var cells = (rows[i] || []).map(str).filter(function (v) { return v !== ''; });
      if (cells.length) return cells;
    }
    return [];
  }
  function describeWhatArrived(rows, headers) {
    var n = (rows || []).length;
    if (!n) return ' The file had no rows at all — the attachment may be empty, or not the export.';
    if (!headers.length) return ' It has ' + n + ' row(s) but every one of them is blank.';
    var shown = headers.slice(0, 12).map(function (h) { return '"' + h + '"'; }).join(', ');
    return ' It has ' + n + ' row(s), and the first row with anything in it reads: ' + shown +
      (headers.length > 12 ? ', …and ' + (headers.length - 12) + ' more' : '') +
      '. If the column has been renamed, that is the name to add.';
  }

  /* ---------- parse one export ----------
     Returns the reqs it could see and the candidates it could see. Either list
     may be empty: the reqs export names no candidates, and a candidate export
     carries no openings count. buildBoard() merges whatever it is given. */
  function parseExport(aoa, fileName) {
    var rows = aoa || [];
    var out = {
      fileName: fileName || '', reqs: [], candidates: [], unknownStatuses: [],
      has: {}, headerRow: -1, rowCount: 0, warnings: []
    };

    var cols = null;
    for (var i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i++) {
      var headers = (rows[i] || []).map(str);
      var c = {};
      Object.keys(COLS).forEach(function (k) { c[k] = pickCol(headers, COLS[k]); });
      if (c.reqId !== -1) { out.headerRow = i; cols = c; break; }
    }
    if (!cols) {
      /* Say what was actually in the file. "No Request-ID column" on its own
         cannot tell a renamed column from an empty export from Power Automate
         having grabbed the wrong attachment -- three problems with three
         different fixes, and no way to choose between them without asking
         somebody to open the file. The headers it DID see answer it. */
      out.sawHeaders = firstPopulatedRow(rows);
      out.warnings.push('No "Request-ID" column was found. Is this a Beeline requisition export?' +
        describeWhatArrived(rows, out.sawHeaders));
      return out;
    }
    out.columns = cols;
    Object.keys(cols).forEach(function (k) { out.has[k] = cols[k] !== -1; });

    var cell = function (row, key) { return cols[key] === -1 ? '' : str(row[cols[key]]); };
    var byId = new Map();
    var conflicts = new Set();

    rows.slice(out.headerRow + 1).forEach(function (raw) {
      var row = raw || [];
      var id = cell(row, 'reqId');
      if (!id) return;
      out.rowCount++;

      var req = {
        id: id,
        status: cell(row, 'status'),
        hiringManager: cell(row, 'hiringMgr'),
        contact: cell(row, 'contact'),
        reportsTo: cell(row, 'reportsTo'),
        startDate: cols.startDate === -1 ? '' : isoDate(row[cols.startDate]),
        requested: cols.requested === -1 ? null : count(row[cols.requested]),
        submitted: cols.submitted === -1 ? null : count(row[cols.submitted]),
        declined: cols.declined === -1 ? null : count(row[cols.declined]),
        offered: cols.offered === -1 ? null : count(row[cols.offered]),
        hired: cols.hired === -1 ? null : count(row[cols.hired]),
        profitCenter: cell(row, 'profitCtr'),
        jobPosition: cell(row, 'jobPosition'),
        location: cell(row, 'location')
      };
      req.market = marketOf(req.profitCenter);

      var prior = byId.get(id);
      if (!prior) {
        byId.set(id, req);
      } else {
        // Req-level columns repeat down every row of a req, but not every column
        // is filled on every row -- "Reports To" is written on one row and left
        // blank on the rest. So a blank is a gap to fill, not a disagreement. Only
        // two rows that both say something, and say different things, are a
        // conflict worth reporting; the first row wins.
        Object.keys(req).forEach(function (k) {
          if (k === 'id') return;
          if (blank(prior[k]) && !blank(req[k])) { prior[k] = req[k]; return; }
          if (!blank(prior[k]) && !blank(req[k]) && prior[k] !== req[k] && !conflicts.has(id)) {
            conflicts.add(id);
            out.warnings.push('Req ' + id + ' has rows that disagree on its ' + k +
              ' ("' + prior[k] + '" vs "' + req[k] + '"). The first row is used.');
          }
        });
      }

      var name = cell(row, 'candidate');
      if (!name) return;   // a req with no candidates still produces one empty row
      var st = cell(row, 'candStatus');
      var meta = statusMeta(st);
      out.candidates.push({
        reqId: id,
        name: name,
        beelineId: cell(row, 'beelineId'),
        externalId: cell(row, 'externalId'),
        jobPosition: cell(row, 'jobPosition'),
        location: cell(row, 'location'),
        status: st,
        statusLabel: meta.label,
        stage: meta.stage,
        tone: meta.tone
      });
      if (meta.unknown && out.unknownStatuses.indexOf(st) === -1) out.unknownStatuses.push(st);
    });

    byId.forEach(function (r) { out.reqs.push(r); });
    if (out.unknownStatuses.length) {
      out.warnings.push('Unrecognised candidate status: ' + out.unknownStatuses.join(', ') +
        '. Those candidates are listed but not counted into a stage.');
    }
    return out;
  }

  // Which export is this? Only for labelling the drop zone -- nothing branches on it.
  function describe(parsed) {
    var h = parsed.has || {};
    if (h.requested && h.candidate) return 'combined';
    if (h.requested) return 'reqs';
    if (h.candidate) return 'candidates';
    return 'unknown';
  }

  /* ---------- merge ----------
     Later sources fill gaps in earlier ones but never overwrite a value that is
     already there, so loading the two files in either order gives the same board. */
  var REQ_FIELDS = ['status', 'hiringManager', 'contact', 'reportsTo', 'startDate',
    'requested', 'submitted', 'declined', 'offered', 'hired',
    'profitCenter', 'market', 'jobPosition', 'location'];

  function buildBoard(opts) {
    opts = opts || {};
    var sources = (opts.sources || []).filter(Boolean);
    var warnings = [];
    var byId = new Map();

    sources.forEach(function (src) {
      (src.warnings || []).forEach(function (w) { warnings.push(w); });
      (src.reqs || []).forEach(function (r) {
        var cur = byId.get(r.id);
        if (!cur) { byId.set(r.id, Object.assign({}, r, { candidates: [], key: reqKey(r.id) })); return; }
        REQ_FIELDS.forEach(function (f) { if (blank(cur[f]) && !blank(r[f])) cur[f] = r[f]; });
      });
    });

    var orphans = [];
    var seenCandidate = new Set();
    sources.forEach(function (src) {
      (src.candidates || []).forEach(function (c) {
        var req = byId.get(c.reqId);
        if (!req) { orphans.push(c); return; }
        // The same candidate can legitimately sit on several reqs, so dedupe is
        // per (req, person) -- never across reqs.
        var key = c.reqId + '|' + (c.beelineId || c.externalId || c.name).toLowerCase();
        if (seenCandidate.has(key)) return;
        seenCandidate.add(key);
        req.candidates.push(c);
      });
    });

    var siteIndex = siteMarketIndex(opts.locations);
    var reqs = [];
    byId.forEach(function (r) { reqs.push(finish(r, siteIndex)); });
    reqs.sort(function (a, b) {
      // Most short-handed first: that is the list somebody actually works from.
      var d = (b.shortBy == null ? -1 : b.shortBy) - (a.shortBy == null ? -1 : a.shortBy);
      if (d !== 0) return d;
      return String(a.startDate || '').localeCompare(String(b.startDate || '')) ||
        a.id.localeCompare(b.id);
    });

    if (orphans.length) {
      warnings.push(orphans.length + ' candidate row(s) reference a Request-ID that is not in the requisition list. ' +
        'They are listed under "Unmatched candidates" rather than dropped.');
    }

    return { reqs: reqs, orphans: orphans, summary: summarize(reqs), warnings: warnings };
  }

  /* Derived per-req figures. Every one of them is null when the export did not
     carry the column it needs -- a missing openings count must read as "not
     reported", never as zero openings or 100% filled. */
  /* Counts derived from the candidates themselves. Used only where the reqs
     export did not supply the column, and flagged as derived so the UI can say so.

     Offered is deliberately NOT derived: no combination of candidate statuses
     reproduces Candidates Offered on more than 104 of 108 reqs, and a figure that
     is right 96% of the time is worse than an honest blank next to a breakdown
     that is exact. */
  function deriveCounts(r) {
    var stages = {};
    STAGE_ORDER.forEach(function (k) { stages[k] = 0; });
    var labels = {};
    r.candidates.forEach(function (c) {
      if (c.stage) stages[c.stage] = (stages[c.stage] || 0) + 1;
      if (c.statusLabel) labels[c.statusLabel] = (labels[c.statusLabel] || 0) + 1;
    });
    r.stages = stages;
    r.statusCounts = labels;
    r.hasCandidateStatus = r.candidates.some(function (c) { return !!c.status; });
    r.derived = {};
    if (r.submitted == null && r.candidateCount) { r.submitted = r.candidateCount; r.derived.submitted = true; }
    if (!r.hasCandidateStatus) return;
    if (r.hired == null) { r.hired = stages.hired; r.derived.hired = true; }
    if (r.declined == null) { r.declined = stages.declined; r.derived.declined = true; }
  }

  /* Fill a gap the loaded export left, and record where the filler came from so
     the UI can say so. A derived market is still a market, but a reader deciding
     something from it deserves to know it was inferred from the site number rather
     than read off the profit centre. */
  function applyMarket(r, siteIndex) {
    if (r.market) return;
    var site = parseLocation(r.location).site;
    if (!site) return;
    // An empty Locations list is not "nothing to report" -- it is the case where
    // every site is unknown, which is precisely what needs saying.
    var m = siteIndex ? siteIndex.get(site) : null;
    if (!m) { r.marketUnknownSite = site; return; }
    r.market = m;
    r.marketFrom = 'site';
  }

  // The figures that depend on requested/hired. Split out of finish() because a
  // later source -- the PLX workbook's quantity -- can supply openings the Beeline
  // export did not, and everything downstream has to be recomputed when it does.
  function recompute(r) {
    r.shortBy = r.requested == null || r.hired == null ? null : Math.max(0, r.requested - r.hired);
    r.fillPct = r.requested == null || r.hired == null || r.requested <= 0
      ? null : Math.round(r.hired / r.requested * 100);
    r.health = r.fillPct == null ? 'unknown'
      : r.fillPct >= 100 ? 'filled'
      : r.fillPct > 0 ? 'partial'
      : r.candidateCount ? 'submitted'
      : 'empty';
  }

  function finish(r, siteIndex) {
    var loc = parseLocation(r.location);
    r.site = loc.site;
    r.city = loc.city;
    r.state = loc.state;

    // Both exports name a supervisor: the reqs file's "Reports To", filled on
    // only a couple of rows, and the candidate file's "Name", filled on all of
    // them. The explicit column wins where it exists.
    r.reportsTo = r.reportsTo || r.contact || '';

    r.candidates.sort(function (a, b) { return a.name.localeCompare(b.name); });
    r.candidateCount = r.candidates.length;

    deriveCounts(r);
    applyMarket(r, siteIndex);
    recompute(r);
    return r;
  }

  /* ---------- reconciliation with the PLX workbook ----------
     The workbook is client-owned and edited by hand, so it drifts: a req can be
     added there before it exists in Beeline, or left open after Beeline filled it.
     Beeline is the system of record, so the workbook never overwrites it -- the
     disagreement is reported and left for a person to settle. */
  function reconcileWorkbook(reqs, workbookRows) {
    var byKey = new Map();
    (workbookRows || []).forEach(function (w) {
      var k = w.key || reqKey(w.reqNumber || w.id);
      if (k) byKey.set(k, w);
    });
    var matched = new Set();
    reqs.forEach(function (r) {
      var w = byKey.get(r.key);
      if (!w) { r.inWorkbook = false; return; }
      matched.add(r.key);
      r.inWorkbook = true;
      r.workbookOpenings = w.openings == null ? null : Number(w.openings);
      r.workbookBuilding = w.building || '';
      r.workbookShift = w.shift || '';
      r.openingsDiffer = r.requested != null && r.workbookOpenings != null &&
        r.requested !== r.workbookOpenings;
    });
    var only = [];
    byKey.forEach(function (w, k) { if (!matched.has(k)) only.push(w); });
    // The board's summary was computed before this ran, so the reconciliation
    // counts are returned here rather than read back off a stale summary.
    return {
      workbookOnly: only,
      inWorkbook: matched.size,
      notInWorkbook: reqs.filter(function (r) { return r.inWorkbook === false; }).length,
      openingsDiffer: reqs.filter(function (r) { return r.openingsDiffer; }).length
    };
  }

  function summarize(reqs) {
    var s = {
      reqs: reqs.length, candidates: 0, requested: null, hired: null,
      hiredAgainstRequested: null, reqsWithOpenings: 0,
      shortBy: null, noCandidates: 0, notInWorkbook: 0, openingsDiffer: 0,
      stages: { hired: 0, offered: 0, review: 0, declined: 0, other: 0 },
      byHealth: { filled: 0, partial: 0, submitted: 0, empty: 0, unknown: 0 }
    };
    reqs.forEach(function (r) {
      s.candidates += r.candidateCount;
      if (r.inWorkbook === false) s.notInWorkbook++;
      if (r.openingsDiffer) s.openingsDiffer++;
      if (r.stages) STAGE_ORDER.forEach(function (k) { s.stages[k] += r.stages[k] || 0; });
      s.byHealth[r.health]++;
      if (!r.candidateCount) s.noCandidates++;
      if (r.requested != null) {
        s.requested = (s.requested || 0) + r.requested;
        s.reqsWithOpenings++;
        // Hires counted against a KNOWN opening count. s.hired is every hire;
        // dividing that by a total openings figure that covers only some of the
        // requests is how you get a 499% fill rate.
        if (r.hired != null) s.hiredAgainstRequested = (s.hiredAgainstRequested || 0) + r.hired;
      }
      if (r.hired != null) s.hired = (s.hired || 0) + r.hired;
      if (r.shortBy != null) s.shortBy = (s.shortBy || 0) + r.shortBy;
    });
    s.fillPct = s.requested == null || s.hiredAgainstRequested == null || s.requested <= 0
      ? null : Math.round(s.hiredAgainstRequested / s.requested * 100);
    return s;
  }

  /* ---------- roster link ----------
     Candidates are matched to roster profiles by id ONLY. A candidate is not
     necessarily a placed associate, so a low match rate is expected and normal --
     and matching a candidate to a profile by name is not safe here: this export
     writes "Maria A Albarran" where the roster writes "Albarran, Maria", so any
     name rule would be guessing at which of two similar people it had found.
     Wrong is worse than unlinked when the row is somebody's employment record. */
  function linkRoster(reqs, profiles, normBadge) {
    if (!profiles || !profiles.size) return reqs;
    var norm = normBadge || function (v) { return str(v); };
    reqs.forEach(function (r) {
      r.candidates.forEach(function (c) {
        var hit = null;
        if (c.externalId) hit = profiles.get(norm(c.externalId));
        if (!hit && c.beelineId) hit = profiles.get(norm(c.beelineId));
        if (!hit) return;
        c.badge = hit.badge;
        c.rosterName = hit.name || '';
        c.market = hit.market || '';
      });
    });
    return reqs;
  }

  /* What a single combined export would have to carry to replace both files.
     Reported in the UI so the gap is visible rather than inferred from a blank
     column. */
  var REQUIRED = [
    { key: 'reqId', label: 'Request-ID', why: 'keys everything' },
    { key: 'requested', label: 'Candidates Requested', why: 'the openings count — without it there is no fill percentage' },
    // Internal Status reproduces these two exactly, so an export carrying it does
    // not also need the aggregate columns.
    { key: 'hired', label: 'Candidates Hired', why: 'how many seats are actually covered',
      derivedFrom: 'candStatus' },
    { key: 'declined', label: 'Candidates Declined', why: 'pipeline detail',
      derivedFrom: 'candStatus' },
    // Not derivable: no candidate-status combination reproduces it reliably.
    { key: 'offered', label: 'Candidates Offered', why: 'pipeline detail' },
    { key: 'profitCtr', label: 'Bill To Profit Center Name', why: 'the market, which ties reqs to the rest of the suite' },
    { key: 'hiringMgr', label: 'Hiring Manager', why: 'the Candidate Status "Name" column is the supervisor, not the hiring manager' },
    { key: 'startDate', label: 'Start Date', why: 'when the seat is needed' },
    { key: 'candidate', label: 'Candidate', why: 'who is attached to the req' },
    { key: 'jobPosition', label: 'Job Position', why: 'what the req is for' },
    { key: 'location', label: 'Location Name', why: 'which building' }
  ];
  function missingColumns(sources) {
    var have = {};
    (sources || []).filter(Boolean).forEach(function (s) {
      Object.keys(s.has || {}).forEach(function (k) { if (s.has[k]) have[k] = true; });
    });
    return REQUIRED.filter(function (r) {
      if (have[r.key]) return false;
      return !(r.derivedFrom && have[r.derivedFrom]);
    });
  }

  /* ---------- storage ----------
     The board is flattened into two shared collections so every manager sees the
     same reqs without re-importing, and so the eventual automated upload writes
     exactly what a manual import writes.

     Reqs keep the existing requisitions collection: a Beeline req IS a
     requisition, and giving it a second home would leave the tab reading two
     lists that disagree. The Request-ID is the record id, so re-importing the
     same req updates it rather than duplicating it. */
  /* Beeline writes only its OWN fields, all namespaced away from the ones the PLX
     workbook sync writes (title, department, shift, building, openings, filled,
     due, reportTo, notes, source, status). Both sources land on the same record --
     they describe the same requisition -- but no field has two writers, so
     whichever syncs last cannot clobber the other, and a disagreement stays
     visible instead of being silently overwritten. */
  function toReqRecords(board) {
    return (board.reqs || []).map(function (r) {
      var loc = parseLocation(r.location);
      return {
        id: r.key || reqKey(r.id),
        beelineReq: r.id,
        beelineStatus: r.status || 'Open',
        beelineOpenings: r.requested,
        hired: r.hired,
        submitted: r.submitted,
        declined: r.declined,
        offered: r.offered,
        jobPosition: r.jobPosition || '',
        startDate: r.startDate || '',
        hiringManager: r.hiringManager || '',
        supervisor: r.reportsTo || '',
        market: r.market || '',
        location: r.location || '',
        city: loc.city || '',
        state: loc.state || '',
        profitCenter: r.profitCenter || ''
      };
    });
  }

  // One record per (req, candidate). The pair is the id, because the same person
  // legitimately sits on several reqs and each of those is its own row.
  function candidateId(c) {
    return reqKey(c.reqId) + '|' + String(c.externalId || c.beelineId || c.name).toLowerCase().replace(/\s+/g, '');
  }
  function toCandidateRecords(board) {
    var out = [];
    (board.reqs || []).forEach(function (r) {
      r.candidates.forEach(function (c) {
        out.push({
          id: candidateId(c),
          reqId: c.reqId,
          name: c.name,
          beelineId: c.beelineId || '',
          externalId: c.externalId || '',
          badge: c.badge || '',
          jobPosition: c.jobPosition || '',
          location: c.location || '',
          status: c.status || ''
        });
      });
    });
    return out;
  }

  /* Rebuild the board from what was stored, so the tab works on a cold load with
     no file in hand. The stored records are the same shape parseExport produces,
     so this goes back through buildBoard rather than reconstructing the derived
     figures a second way. */
  function fromRecords(reqRecords, candidateRecords, locations) {
    var source = { reqs: [], candidates: [], warnings: [] };
    // The PLX workbook sync writes onto the SAME record, so reconciliation is read
    // straight off it: what the workbook says about this requisition is already
    // sitting beside what Beeline says.
    var wb = new Map(), workbookOnly = [], manual = [];
    (reqRecords || []).forEach(function (r) {
      var fromWorkbook = r.source === 'PLX workbook';
      if (fromWorkbook) wb.set(String(r.id), r);
      if (!r.beelineReq) { (fromWorkbook ? workbookOnly : manual).push(r); }
    });
    (reqRecords || []).forEach(function (r) {
      // A record is a Beeline req exactly when the import stamped a Request-ID on
      // it. Workbook-only rows and hand-entered rows have none, and belong to
      // their own lists -- counting one twice would show it twice.
      if (!r.beelineReq) return;
      source.reqs.push({
        id: String(r.beelineReq),
        status: r.beelineStatus || '',
        hiringManager: r.hiringManager || '',
        contact: '',
        reportsTo: r.supervisor || '',
        startDate: r.startDate || '',
        requested: r.beelineOpenings == null ? null : Number(r.beelineOpenings),
        submitted: r.submitted == null ? null : Number(r.submitted),
        declined: r.declined == null ? null : Number(r.declined),
        offered: r.offered == null ? null : Number(r.offered),
        hired: r.hired == null ? null : Number(r.hired),
        profitCenter: r.profitCenter || '',
        market: r.market || '',
        jobPosition: r.jobPosition || '',
        location: r.location || ''
      });
    });
    (candidateRecords || []).forEach(function (c) {
      var meta = statusMeta(c.status);
      source.candidates.push({
        reqId: String(c.reqId), name: c.name || '',
        beelineId: c.beelineId || '', externalId: c.externalId || '',
        jobPosition: c.jobPosition || '', location: c.location || '',
        badge: c.badge || '',
        status: c.status || '', statusLabel: meta.label, stage: meta.stage, tone: meta.tone
      });
    });
    var board = buildBoard({ sources: [source], locations: locations });
    board.reqs.forEach(function (r) {
      var w = wb.get(r.key);
      r.inWorkbook = !!w;
      r.workbookOpenings = w && w.openings != null && w.openings !== '' ? Number(w.openings) : null;
      if (!isFinite(r.workbookOpenings)) r.workbookOpenings = null;
      r.workbookBuilding = w ? (w.building || '') : '';
      r.workbookShift = w ? (w.shift || '') : '';
      // The Beeline export no longer carries Candidates Requested, so where the
      // workbook states a quantity for this requisition it IS the openings count.
      // Beeline still wins where it says anything -- this fills a gap, it does not
      // override -- and the fill is labelled so nobody reads an inferred number as
      // one Beeline reported.
      if (r.requested == null && r.workbookOpenings != null) {
        r.requested = r.workbookOpenings;
        r.requestedFrom = 'workbook';
        recompute(r);
      }
      r.openingsDiffer = r.requestedFrom !== 'workbook' &&
        r.requested != null && r.workbookOpenings != null &&
        r.requested !== r.workbookOpenings;
    });
    board.summary = summarize(board.reqs);
    board.summary.inWorkbook = board.reqs.filter(function (r) { return r.inWorkbook; }).length;
    board.summary.notInWorkbook = board.reqs.length - board.summary.inWorkbook;
    board.summary.openingsDiffer = board.reqs.filter(function (r) { return r.openingsDiffer; }).length;
    // Requisitions that exist in one place only. The workbook is client-owned and
    // hand-edited, so a row here is usually a req added there before Beeline had
    // it, or one left open after Beeline filled it -- either way a person settles
    // it, not this code.
    board.workbookOnly = workbookOnly;
    board.manual = manual;
    return board;
  }

  /* An import updates the Beeline half of each requisition and leaves every other
     field as it was. A record can be carrying PLX workbook data for the same
     requisition, or be a hand-entered position Beeline does not know about, and
     neither may be quietly deleted or overwritten by this import.

     Reqs that were in Beeline before and are not now have their Beeline half
     cleared rather than the record dropped: anything the workbook or a person put
     there is still the only record of it. */
  function mergeForSave(existing, imported) {
    var BEELINE_FIELDS = ['beelineReq', 'beelineStatus', 'beelineOpenings', 'hired', 'submitted',
      'declined', 'offered', 'jobPosition', 'startDate', 'hiringManager', 'supervisor',
      'market', 'location', 'city', 'state', 'profitCenter'];
    var out = [], byId = new Map();
    (existing || []).forEach(function (r) {
      var copy = Object.assign({}, r);
      byId.set(String(r.id), copy);
      out.push(copy);
    });
    (imported || []).forEach(function (rec) {
      var cur = byId.get(String(rec.id));
      if (!cur) { out.push(Object.assign({}, rec)); byId.set(String(rec.id), rec); return; }
      BEELINE_FIELDS.forEach(function (f) { cur[f] = rec[f]; });
    });
    var live = new Set((imported || []).map(function (r) { return String(r.id); }));
    out.forEach(function (r) {
      if (r.beelineReq && !live.has(String(r.id))) {
        BEELINE_FIELDS.forEach(function (f) { delete r[f]; });
      }
    });
    return out;
  }

  return {
    COLS: COLS,
    REQUIRED: REQUIRED,
    isoDate: isoDate,
    count: count,
    marketOf: marketOf,
    parseLocation: parseLocation,
    parseExport: parseExport,
    describe: describe,
    buildBoard: buildBoard,
    linkRoster: linkRoster,
    missingColumns: missingColumns,
    siteMarketIndex: siteMarketIndex,
    learnSiteMarkets: learnSiteMarkets,
    recompute: recompute,
    CANDIDATE_STATUS: CANDIDATE_STATUS,
    STAGE_ORDER: STAGE_ORDER,
    statusMeta: statusMeta,
    reqKey: reqKey,
    reconcileWorkbook: reconcileWorkbook,
    toReqRecords: toReqRecords,
    toCandidateRecords: toCandidateRecords,
    candidateId: candidateId,
    fromRecords: fromRecords,
    mergeForSave: mergeForSave
  };
});
