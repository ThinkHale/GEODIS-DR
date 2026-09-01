/* GEODIS Management Suite -- the shared IL PTO tracker.
 *
 * One workbook, shared by two branches that keep it differently:
 *
 *   30080                    St. Louis. Every PTO request, GEODIS and not --
 *                            Crescent Park, Fed Ex and Kraft sit on the same tab.
 *   GEODIS - 20062           Chicago, approved but not yet processed.
 *   20062 Geodis Processed   Chicago, processed.
 *
 * So the sheet a row sits on is what says where it stands, and the tab names are
 * the only thing that says so. They are matched loosely, because a shared
 * workbook gets renamed: "GEODIS - 20062" and "20062 Geodis Processed" differ by
 * word order and the branch number moves.
 *
 * The three tabs do not share a shape. 30080 has no Assignment # and calls its
 * decision column "Manager Approval"; the Chicago tabs call it "Status"; only the
 * processed tab has "Processed"; and two of the three carry a banner row above
 * the header. Columns are therefore found by header text, and the header row by
 * looking for "Associate Name" -- never by position.
 *
 * No DOM access, so a scheduled Cloud Function can reuse this when the workbook is
 * watched on SharePoint rather than uploaded by hand.
 */
(function (root) {
  'use strict';

  /* ---------- which tab is which ----------
     Ordered: "20062 Geodis Processed" also matches the pending pattern, so the
     processed test has to run first. */
  var TABS = [
    { kind: 'processed', test: /geodis/i, andTest: /process/i, branch: '20062',
      status: 'Completed', label: 'Chicago — processed' },
    /* A row on a working tab has been approved and handed to payroll -- that is
       what the tabs are for, and both carry a banner telling people to have it in
       before the payroll deadline. It becomes Completed when it appears on the
       processed tab, and not before. */
    { kind: 'pending', test: /geodis/i, branch: '20062',
      status: 'Submitted to Payroll', label: 'Chicago — with payroll, not yet processed' },
    { kind: 'branch', test: /^\s*30080\s*$/, branch: '30080',
      status: 'Submitted to Payroll', label: 'St. Louis — with payroll' }
  ];
  function tabFor(name) {
    var n = String(name || '');
    for (var i = 0; i < TABS.length; i++) {
      var t = TABS[i];
      if (!t.test.test(n)) continue;
      if (t.andTest && !t.andTest.test(n)) continue;
      if (t.andTest === undefined && t.kind === 'pending' && /process/i.test(n)) continue;
      return t;
    }
    return null;
  }

  /* ---------- columns ---------- */
  var COLS = {
    name:       [/associate name/i, /^name$/i],
    eid:        [/^eid$/i, /employee id/i],
    assignment: [/assignment\s*#?/i],
    client:     [/^client$/i],
    submitted:  [/submission date/i, /submitted/i],
    requested:  [/request date/i, /^requested$/i],
    weekending: [/week\s*ending/i],
    hours:      [/^hours$/i],
    available:  [/pto available/i, /^available$/i],
    eligibility:[/eligibilit/i],
    markup:     [/mark\s*up/i],
    requestor:  [/requestor/i, /requested by/i],
    // 30080 says "Manager Approval"; the Chicago tabs say "Status".
    decision:   [/manager approval/i, /^status$/i],
    processed:  [/^processed$/i],
    notes:      [/^notes?$/i]
  };
  function pickCol(headers, patterns) {
    for (var i = 0; i < patterns.length; i++) {
      var idx = headers.findIndex(function (h) { return patterns[i].test(h); });
      if (idx !== -1) return idx;
    }
    return -1;
  }
  function str(v) { return v == null ? '' : String(v).trim(); }

  /* ---------- GEODIS or not ----------
     30080 keeps every client on one tab, so most of its rows belong to somebody
     else entirely. They are counted, never imported: a Kraft associate has no
     profile here and their PTO is not this tool's business. */
  function isGeodis(client) { return /geodis/i.test(str(client)); }

  /* ---------- dates ----------
     The tracker is typed by hand into a shared sheet and it shows: "8/24/26",
     "13-Jul" with no year at all, and two dates crammed into one cell as
     "6/15/2026 & 6/16/2026". Each is read for what it plainly says; a year that
     is genuinely absent is taken from the submission date on the same row, which
     is the only other date the row states. */
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }

  function parseOneDate(v, contextYear) {
    var s = str(v);
    if (!s || /^n\/?a$/i.test(s)) return null;
    if (v instanceof Date && !isNaN(v.getTime())) return iso(v.getFullYear(), v.getMonth() + 1, v.getDate());
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (m) {
      var y = Number(m[3]);
      if (y < 100) y += 2000;
      return iso(y, Number(m[1]), Number(m[2]));
    }
    // "13-Jul": a day and a month, and no year anywhere in the cell.
    m = s.match(/^(\d{1,2})-([A-Za-z]{3})/);
    if (m && MONTHS[m[2].toLowerCase()]) {
      if (!contextYear) return null;
      return iso(contextYear, MONTHS[m[2].toLowerCase()], Number(m[1]));
    }
    return null;
  }

  // One cell can hold more than one date. Returns every date it states, in order.
  function parseDates(v, contextYear) {
    var s = str(v);
    if (!s) return [];
    return s.split(/\s*(?:&|,| and | \+ )\s*/i)
      .map(function (part) { return parseOneDate(part, contextYear); })
      .filter(Boolean);
  }
  function yearOf(isoDate) {
    var m = String(isoDate || '').match(/^(\d{4})/);
    return m ? Number(m[1]) : 0;
  }

  /* ---------- status ----------
     The tab says where a request stands; the decision column says whether it was
     agreed. A row that is not approved keeps what it actually says rather than
     being forced into the pipeline's vocabulary. */
  function statusFor(tab, decision, processed) {
    var d = str(decision).toLowerCase();
    if (/den(y|ied)|reject/.test(d)) return 'Denied';
    if (/cancel/.test(d)) return 'Cancelled';
    // "Yes" in Processed means payroll is done with it, whatever the tab.
    if (/^y(es)?$/i.test(str(processed))) return 'Completed';
    return tab.status;
  }

  /* ---------- parse ----------
     sheets: [{ name, aoa }] -- every tab in the workbook. Tabs that are not one of
     the three are skipped and named, so a renamed tab is visible rather than
     quietly contributing nothing. */
  function parseTracker(sheets) {
    var out = { requests: [], sheets: [], skipped: [], warnings: [], otherClients: {} , nonGeodis: 0 };

    (sheets || []).forEach(function (sheet) {
      var tab = tabFor(sheet.name);
      if (!tab) { out.skipped.push(sheet.name); return; }
      var aoa = sheet.aoa || [];

      var headerRow = -1, cols = null;
      for (var i = 0; i < Math.min(aoa.length, 10); i++) {
        var headers = (aoa[i] || []).map(str);
        var c = {};
        Object.keys(COLS).forEach(function (k) { c[k] = pickCol(headers, COLS[k]); });
        if (c.name !== -1 && c.requested !== -1) { headerRow = i; cols = c; break; }
      }
      if (headerRow === -1) {
        out.warnings.push('"' + sheet.name + '" has no "Associate Name" and "Request Date" header, so it was skipped.');
        return;
      }

      var kept = 0, skippedHere = 0;
      var cell = function (row, key) { return cols[key] === -1 ? '' : str(row[cols[key]]); };

      aoa.slice(headerRow + 1).forEach(function (raw, n) {
        var row = raw || [];
        var name = cell(row, 'name');
        if (!name) return;
        var client = cell(row, 'client');
        if (!isGeodis(client)) {
          // 30080 carries other clients; count them so the total is explainable.
          skippedHere++;
          out.nonGeodis++;
          var key = client || '(no client)';
          out.otherClients[key] = (out.otherClients[key] || 0) + 1;
          return;
        }

        var submitted = parseOneDate(cell(row, 'submitted'));
        var ctxYear = yearOf(submitted) || yearOf(parseOneDate(cell(row, 'weekending')));
        var dates = parseDates(cell(row, 'requested'), ctxYear);
        var weekending = parseOneDate(cell(row, 'weekending'), ctxYear);

        if (!dates.length) {
          out.warnings.push(sheet.name + ' row ' + (headerRow + n + 2) + ' (' + name +
            '): no usable request date' + (cell(row, 'requested') ? ' in "' + cell(row, 'requested') + '"' : '') +
            '. Imported against the week ending instead.');
        }
        var start = dates[0] || weekending || '';
        var end = dates.length > 1 ? dates[dates.length - 1] : start;

        var hoursRaw = cell(row, 'hours').replace(/,/g, '');
        var hours = hoursRaw === '' ? null : Number(hoursRaw);
        if (hours != null && !isFinite(hours)) {
          out.warnings.push(sheet.name + ' row ' + (headerRow + n + 2) + ' (' + name +
            '): "' + cell(row, 'hours') + '" is not a number of hours.');
          hours = null;
        }

        kept++;
        out.requests.push({
          sheet: sheet.name,
          kind: tab.kind,
          branch: tab.branch,
          row: headerRow + n + 2,
          name: name,
          eid: cell(row, 'eid'),
          assignment: cell(row, 'assignment'),
          client: client,
          submitted: submitted || '',
          start: start,
          end: end,
          dates: dates,
          multiDay: dates.length > 1,
          weekending: weekending || '',
          hours: hours,
          available: cell(row, 'available'),
          eligibility: cell(row, 'eligibility'),
          requestor: cell(row, 'requestor'),
          decision: cell(row, 'decision'),
          processed: cell(row, 'processed'),
          notes: cell(row, 'notes'),
          status: statusFor(tab, cell(row, 'decision'), cell(row, 'processed'))
        });
      });

      out.sheets.push({ name: sheet.name, kind: tab.kind, branch: tab.branch,
        label: tab.label, headerRow: headerRow, kept: kept, skipped: skippedHere });
    });

    return out;
  }

  /* ---------- into the time-off collection ----------
     The tracker is not a second home for PTO; it is another way a request arrives,
     alongside the Microsoft Forms intake. So its rows become ordinary time-off
     records and go through the same status pipeline.

     The id is EID + the days it covers, deliberately WITHOUT the hours. A request
     that moves from the pending tab to the processed one, or has its hours
     corrected in the sheet, is the same request and has to update its record
     rather than leave a stale twin behind. Nothing in the workbook collides on
     that key: 56 GEODIS rows, 56 distinct keys, and none appearing on two tabs.

     A row whose EID reaches no profile is still imported, with no badge. The
     suite already surfaces unmatched time-off for somebody to connect by hand,
     and dropping the row instead would lose an approved day off. */
  function requestId(r) {
    var days = r.start === r.end ? r.start : r.start + '_' + r.end;
    return 'PTOIL-' + String(r.eid || 'noeid').replace(/[^A-Za-z0-9_-]/g, '') + '-' + days;
  }

  function noteFor(r) {
    return [
      r.notes && r.notes !== r.branch ? r.notes : '',
      r.client ? 'Client: ' + r.client : '',
      r.eligibility ? 'Eligibility: ' + r.eligibility : '',
      r.available !== '' && r.available != null ? 'Balance on the sheet: ' + r.available : '',
      r.requestor ? 'Requested by ' + r.requestor : '',
      r.assignment ? 'Assignment ' + r.assignment : '',
      r.multiDay ? 'The sheet listed ' + r.dates.length + ' dates in one cell.' : '',
      r.sheet === r.branch ? 'Branch ' + r.branch : 'Branch ' + r.branch + ' · ' + r.sheet
    ].filter(Boolean).join(' | ').slice(0, 500);
  }

  /* opts: { badgeForEid(eid) -> badge|'', source, now, pipeline } */
  function toTimeOffRecords(parsed, opts) {
    opts = opts || {};
    var lookup = opts.badgeForEid || function () { return ''; };
    var source = opts.source || 'IL Shared PTO Tracker';
    var now = opts.now instanceof Date ? opts.now : new Date();
    var pipeline = opts.pipeline;
    var out = [], unmatched = [];

    (parsed.requests || []).forEach(function (r) {
      var badge = lookup(r.eid) || '';
      var rec = {
        id: requestId(r),
        badge: badge,
        name: r.name,
        type: 'PTO',
        start: r.start,
        end: r.end,
        hours: r.hours == null ? 0 : r.hours,
        status: r.status,
        notes: noteFor(r),
        location: r.client || '',
        source: source,
        submittedAt: r.submitted ? r.submitted + 'T00:00:00.000Z' : now.toISOString(),
        importRef: r.sheet + ' row ' + r.row
      };
      /* The log is written by the pipeline rather than assembled here, so an
         imported request carries the same history shape as one somebody moved by
         hand and nothing downstream has to tell them apart. */
      if (pipeline && pipeline.applyStatus) {
        var actor = pipeline.actorOf ? pipeline.actorOf(source, '', 'import') : { name: source, id: '', source: 'import' };
        var applied = pipeline.applyStatus(rec, r.status, actor, now);
        rec.status = applied.status;
        rec.statusUpdatedAt = applied.statusUpdatedAt;
        rec.statusUpdatedBy = applied.statusUpdatedBy;
        rec.statusHistory = applied.statusHistory;
      }
      if (!badge) unmatched.push({ eid: r.eid, name: r.name, sheet: r.sheet, row: r.row });
      out.push(rec);
    });

    return { records: out, unmatched: unmatched };
  }

  /* An import updates what this tracker says and leaves every other time-off record
     alone -- the Forms intake and anything entered by hand are not this workbook's
     to touch.

     It also deletes nothing. A request that disappears from the sheet without
     reaching the processed tab is not evidence it did not happen; it is a shared
     spreadsheet somebody edited. Silently dropping it would erase an approved day
     off, and quietly keeping it would let a cancellation sit as though it were
     still with payroll. So the record stays exactly as it was and the
     disappearance is reported, for a task somebody answers.

     A request that had already completed is left alone when it goes: the processed
     tab is trimmed as it grows, and that is housekeeping, not a decision. */
  function mergeForSave(existing, imported, source) {
    source = source || 'IL Shared PTO Tracker';
    var incoming = imported || [];
    var byId = {};
    incoming.forEach(function (r) { byId[String(r.id)] = r; });

    var out = [], vanished = [];
    (existing || []).forEach(function (r) {
      if (r.source !== source) { out.push(r); return; }      // somebody else's record
      if (byId[String(r.id)]) return;                        // still on the sheet; replaced below
      out.push(r);                                           // gone from the sheet, kept regardless
      if (String(r.status || '') !== 'Completed') vanished.push(r);
    });
    return { records: out.concat(incoming), vanished: vanished };
  }

  /* A task for each request that left the sheet with payroll still holding it.
     The id is derived from the request, so re-importing updates one task rather
     than growing a pile of identical ones, and answering it closes the question
     rather than the row reappearing tomorrow. */
  function vanishedTasks(vanished, opts) {
    opts = opts || {};
    var tasks = opts.tasks;
    if (!tasks || !tasks.create) return [];
    var existing = opts.existing || [];
    var actor = opts.actor || { name: opts.source || 'IL Shared PTO Tracker', id: '', source: 'import' };
    var now = opts.now instanceof Date ? opts.now : new Date();
    return (vanished || []).map(function (r) {
      var id = tasks.idFor ? tasks.idFor('ptoTracker', r.id) : 'TK:ptoTracker:' + r.id;
      var already = (existing || []).filter(function (t) { return t && t.id === id; })[0];
      if (already) return null;    // already asked; asking again every morning is noise
      var when = r.start === r.end ? r.start : r.start + ' to ' + r.end;
      return tasks.create({
        id: id,
        kind: 'pto',
        title: 'PTO left the tracker before it was processed',
        detail: (r.name || 'This associate') + ' — ' + (r.hours || 0) + 'h on ' + when +
          ' was on the tracker and is no longer on any tab, and it never reached the processed tab. ' +
          'Confirm whether it was paid, cancelled, or removed by mistake.',
        badge: r.badge || '',
        name: r.name || '',
        location: r.location || '',
        source: opts.source || 'IL Shared PTO Tracker',
        sourceKind: 'ptoTracker',
        sourceId: r.id
      }, actor, now);
    }).filter(Boolean);
  }

  root.PtoTrackerCore = {
    TABS: TABS,
    COLS: COLS,
    tabFor: tabFor,
    isGeodis: isGeodis,
    parseOneDate: parseOneDate,
    parseDates: parseDates,
    statusFor: statusFor,
    parseTracker: parseTracker,
    requestId: requestId,
    toTimeOffRecords: toTimeOffRecords,
    mergeForSave: mergeForSave,
    vanishedTasks: vanishedTasks
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PtoTrackerCore;
})(typeof window !== 'undefined' ? window : this);
