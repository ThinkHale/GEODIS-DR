/* GEODIS Management Suite -- what changed in the PLX workbook between uploads.
 *
 * The workbook is overwritten in place on SharePoint, so on its own it can only
 * say what is true now. Every upload is therefore reduced to a small snapshot of
 * the things a staffing meeting asks about, and two snapshots are compared:
 *
 *   "<site> - HC"           one row per associate on assignment, keyed by EID
 *   WT List / Pipeline /    one row per candidate. They move between these tabs
 *   STARTED / DNR tabs      as they progress, so a candidate is followed by name
 *                           across all of them rather than per tab
 *   "Beeline Reqs"          one row per open order, keyed by Req #
 *   "Attendance"            one row per occurrence
 *
 * The workbook records state, never events, so every "event" here is inferred
 * from two states. The definitions are deliberately literal, so the numbers can
 * be explained in the meeting they are read out in:
 *
 *   assignment started      an EID on an HC tab that was not on any HC tab before
 *   assignment ended        an EID that has left every HC tab
 *   walkthrough scheduled   a candidate whose WT date was blank (or who is new)
 *   walkthrough rescheduled a WT date that changed from one value to another
 *   walkthrough completed   a candidate who has moved onto a STARTED tab
 *   walkthrough cancelled   a candidate who has moved onto a DNR / cancelled tab
 *   order created           a Req # that was not on the Beeline Reqs tab before
 *   order filled / closed   a Req # that has left the tab. The sheet does not say
 *                           which, and the sync already treats it as closed
 *
 * No DOM access and no storage: the Cloud Function stores and loads snapshots,
 * this only builds and compares them. Keep functions/plx-history-core.js
 * identical to this file.
 */
(function (root) {
  'use strict';

  var VERSION = 1;
  var RETENTION_DAYS = 7;
  var DAY_MS = 24 * 60 * 60 * 1000;

  var HC_SHEET = /HC$/;
  var REQ_SHEET = /beeline\s*reqs/i;
  var ATTENDANCE_SHEET = /attendance$/i;
  var NAME_HEADER = /^employee\s+name$/i;
  var CANDIDATE_NAME = /last\s*name.*first\s*name/i;

  /* Which stage a candidate tab represents. Order matters: "2026 - NOT ELIGIBLE
     Cancelled" must read as cancelled before anything else gets a look at it. */
  var STAGES = [
    { stage: 'cancelled', re: /dnr|cancel|not\s*eligible/i },
    { stage: 'started', re: /started/i },
    { stage: 'pipeline', re: /pipeline/i },
    { stage: 'openings', re: /wt\s*list|openings/i }
  ];
  // When one name is on two tabs (a row nobody deleted), the furthest stage wins.
  var STAGE_RANK = { openings: 1, pipeline: 2, cancelled: 3, started: 4 };

  function txt(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }
  function nameKey(v) {
    // Order-insensitive, like the rest of the suite: "Luz Grachen" and
    // "Grachen, Luz" are one person.
    return txt(v).toLowerCase().replace(/[^a-z0-9ñáéíóúü\s]/g, ' ').split(/\s+/)
      .filter(Boolean).sort().join(' ');
  }
  function pick(headers, re) {
    for (var i = 0; i < headers.length; i++) if (re.test(headers[i])) return i;
    return -1;
  }
  function cell(cells, i) { return i === -1 || i == null ? '' : txt(cells[i]); }
  function stageOf(sheetName) {
    for (var i = 0; i < STAGES.length; i++) if (STAGES[i].re.test(sheetName)) return STAGES[i].stage;
    return '';
  }

  /* ---------- the HC tabs ----------
     Read independently of shift-key.js's parseHeadcount, which drops anybody with
     no shift -- correct for shift tags, wrong here, where a new start nobody has
     given a shift yet is exactly the person the meeting wants to hear about. */
  function readRoster(sheets) {
    var roster = {};
    sheets.forEach(function (sheet) {
      if (!HC_SHEET.test(sheet.name)) return;
      var building = (sheet.name.match(/^(\d+)/) || [])[1] || '';
      var aoa = sheet.aoa || [];
      for (var h = 0; h < Math.min(aoa.length, 8); h++) {
        var headers = (aoa[h] || []).map(txt);
        var starts = [];
        headers.forEach(function (x, i) { if (NAME_HEADER.test(x)) starts.push(i); });
        if (!starts.length) continue;
        starts.forEach(function (start, b) {
          var end = b + 1 < starts.length ? starts[b + 1] : headers.length;
          var block = headers.slice(start, end);
          var col = {
            eid: start + Math.max(1, pick(block, /^eid$/i)),
            startDate: start + Math.max(2, pick(block, /start\s*date/i)),
            shift: start + Math.max(3, pick(block, /^shift$/i)),
            comments: start + pick(block, /^comments?$/i)
          };
          if (col.comments < start) col.comments = -1;
          aoa.slice(h + 1).forEach(function (row) {
            var cells = row || [];
            var name = cell(cells, start), eid = cell(cells, col.eid).toUpperCase();
            if (!name || !/^\d+-/.test(eid)) return;
            if (roster[eid]) return;   // listed twice: the first row stands
            roster[eid] = {
              eid: eid, name: name, location: building, site: sheet.name,
              shift: cell(cells, col.shift), startDate: cell(cells, col.startDate),
              comments: cell(cells, col.comments)
            };
          });
        });
        break;
      }
    });
    return roster;
  }

  /* ---------- the candidate tabs ---------- */
  function readCandidates(sheets) {
    var people = {}, openSlots = {};
    sheets.forEach(function (sheet) {
      var stage = stageOf(sheet.name);
      if (!stage) return;
      var aoa = sheet.aoa || [];
      for (var h = 0; h < Math.min(aoa.length, 6); h++) {
        var headers = (aoa[h] || []).map(txt);
        var col = {
          name: pick(headers, CANDIDATE_NAME),
          building: pick(headers, /^b\w*ilding$/i),   // "Biuilding" on one tab
          account: pick(headers, /^account$/i),
          position: pick(headers, /^position$/i),
          shift: pick(headers, /^shift$/i),
          startDate: pick(headers, /^start\s*date$/i),
          wtDate: pick(headers, /^wt\s*date/i)
        };
        if (col.name === -1) continue;
        aoa.slice(h + 1).forEach(function (row) {
          var cells = row || [];
          var name = cell(cells, col.name), building = cell(cells, col.building);
          if (!name) {
            // A named position with nobody in it yet: an unfilled walkthrough slot.
            if (stage === 'openings' && building) openSlots[building] = (openSlots[building] || 0) + 1;
            return;
          }
          var key = nameKey(name);
          if (!key) return;
          var prior = people[key];
          if (prior && STAGE_RANK[prior.stage] >= STAGE_RANK[stage]) return;
          people[key] = {
            key: key, name: name, stage: stage, tab: sheet.name, location: building,
            account: cell(cells, col.account), position: cell(cells, col.position),
            shift: cell(cells, col.shift), startDate: cell(cells, col.startDate),
            wtDate: cell(cells, col.wtDate)
          };
        });
        break;
      }
    });
    return { people: people, openSlots: openSlots };
  }

  /* ---------- the Beeline Reqs tab ----------
     Parsed by shift-key.js, which the sync already trusts with these rows. */
  function readOrders(sheets, ShiftKey) {
    var orders = {};
    var sheet = sheets.filter(function (s) { return REQ_SHEET.test(s.name); })[0];
    if (!sheet || !ShiftKey) return orders;
    ShiftKey.parseRequisitions(sheet.aoa).rows.forEach(function (r) {
      orders[r.reqNumber] = {
        req: r.reqNumber, location: r.building, account: r.account, shift: r.shift,
        jobType: r.jobType, hireDate: r.hireDate, openings: r.openings
      };
    });
    return orders;
  }

  /* ---------- the attendance tab ----------
     Two side-by-side blocks (current and transition history). An occurrence has
     no id of its own, so it is keyed by who, when and how many points. */
  function readAttendance(sheets) {
    var events = {};
    sheets.forEach(function (sheet) {
      if (!ATTENDANCE_SHEET.test(sheet.name)) return;
      var aoa = sheet.aoa || [];
      for (var h = 0; h < Math.min(aoa.length, 6); h++) {
        var headers = (aoa[h] || []).map(txt);
        var starts = [];
        headers.forEach(function (x, i) { if (NAME_HEADER.test(x)) starts.push(i); });
        if (!starts.length) continue;
        starts.forEach(function (start, b) {
          var from = b ? starts[b - 1] + 1 : 0;
          var to = b + 1 < starts.length ? starts[b + 1] : headers.length;
          var block = headers.slice(from, to);
          var off = function (re) { var i = pick(block, re); return i === -1 ? -1 : from + i; };
          var col = { eid: off(/^eid$/i), date: off(/date of absence/i), points: off(/points/i),
            building: off(/^building$/i), comments: off(/^comments?$/i) };
          if (col.date === -1) return;
          aoa.slice(h + 1).forEach(function (row) {
            var cells = row || [];
            var name = cell(cells, start), date = cell(cells, col.date);
            if (!name || !date) return;
            var eid = cell(cells, col.eid).toUpperCase();
            var points = cell(cells, col.points);
            var id = (eid || nameKey(name)) + '|' + date + '|' + points;
            if (events[id]) return;
            events[id] = { id: id, eid: eid, name: name, date: date, points: points,
              location: (cell(cells, col.building).match(/^\d+/) || [''])[0],
              comments: cell(cells, col.comments) };
          });
        });
        break;
      }
    });
    return events;
  }

  /* Everything a later upload is compared against. `sheets` is the same
     [{ name, aoa }] list the sync already builds, so the workbook is read once. */
  function snapshot(sheets, opts) {
    opts = opts || {};
    sheets = sheets || [];
    var candidates = readCandidates(sheets);
    return {
      version: VERSION,
      takenAt: opts.takenAt || new Date().toISOString(),
      roster: readRoster(sheets),
      candidates: candidates.people,
      openSlots: candidates.openSlots,
      orders: readOrders(sheets, opts.ShiftKey),
      attendance: readAttendance(sheets)
    };
  }

  /* ---------- comparing two snapshots ---------- */
  function values(obj) { return Object.keys(obj || {}).map(function (k) { return obj[k]; }); }
  function byLocationThenName(a, b) {
    return String(a.location || '').localeCompare(String(b.location || '')) ||
      String(a.name || a.req || '').localeCompare(String(b.name || b.req || ''));
  }

  function diff(before, after) {
    var b = before || {}, a = after || {};
    var out = {
      assignments: { started: [], ended: [] },
      walkthroughs: { scheduled: [], rescheduled: [], completed: [], cancelled: [] },
      orders: { created: [], closed: [], changed: [] },
      attendance: { logged: [] },
      headcount: [],
      openSlots: []
    };
    var ra = a.roster || {}, rb = b.roster || {};
    Object.keys(ra).forEach(function (k) { if (!rb[k]) out.assignments.started.push(ra[k]); });
    Object.keys(rb).forEach(function (k) { if (!ra[k]) out.assignments.ended.push(rb[k]); });

    var ca = a.candidates || {}, cb = b.candidates || {};
    Object.keys(ca).forEach(function (k) {
      var now = ca[k], was = cb[k];
      if (now.wtDate && (!was || !was.wtDate) && now.stage !== 'cancelled') out.walkthroughs.scheduled.push(now);
      else if (now.wtDate && was && was.wtDate && now.wtDate !== was.wtDate) {
        out.walkthroughs.rescheduled.push(Object.assign({}, now, { fromWtDate: was.wtDate }));
      }
      if (now.stage === 'started' && (!was || was.stage !== 'started')) {
        out.walkthroughs.completed.push(Object.assign({}, now, { fromStage: was ? was.stage : '' }));
      }
      if (now.stage === 'cancelled' && was && was.stage !== 'cancelled') {
        out.walkthroughs.cancelled.push(Object.assign({}, now, { fromStage: was.stage }));
      }
    });

    var oa = a.orders || {}, ob = b.orders || {};
    Object.keys(oa).forEach(function (k) {
      if (!ob[k]) out.orders.created.push(oa[k]);
      else if (Number(ob[k].openings) !== Number(oa[k].openings)) {
        out.orders.changed.push(Object.assign({}, oa[k], { fromOpenings: ob[k].openings }));
      }
    });
    Object.keys(ob).forEach(function (k) { if (!oa[k]) out.orders.closed.push(ob[k]); });

    var aa = a.attendance || {}, ab = b.attendance || {};
    Object.keys(aa).forEach(function (k) { if (!ab[k]) out.attendance.logged.push(aa[k]); });

    // Net headcount and open slots per building, so a quiet site reads as quiet
    // rather than missing.
    var count = function (roster) {
      var n = {};
      values(roster).forEach(function (p) { n[p.location] = (n[p.location] || 0) + 1; });
      return n;
    };
    var hb = count(rb), ha = count(ra);
    Object.keys(Object.assign({}, hb, ha)).sort().forEach(function (loc) {
      out.headcount.push({ location: loc, from: hb[loc] || 0, to: ha[loc] || 0 });
    });
    var sb = b.openSlots || {}, sa = a.openSlots || {};
    Object.keys(Object.assign({}, sb, sa)).sort().forEach(function (loc) {
      out.openSlots.push({ location: loc, from: sb[loc] || 0, to: sa[loc] || 0 });
    });

    [out.assignments, out.walkthroughs, out.orders, out.attendance].forEach(function (group) {
      Object.keys(group).forEach(function (k) { group[k].sort(byLocationThenName); });
    });
    out.counts = counts(out);
    return out;
  }

  function sum(list, field) {
    return list.reduce(function (n, x) { return n + (Number(x[field]) || 0); }, 0);
  }
  function counts(d) {
    return {
      started: d.assignments.started.length,
      ended: d.assignments.ended.length,
      wtScheduled: d.walkthroughs.scheduled.length,
      wtRescheduled: d.walkthroughs.rescheduled.length,
      wtCompleted: d.walkthroughs.completed.length,
      wtCancelled: d.walkthroughs.cancelled.length,
      ordersCreated: d.orders.created.length,
      openingsCreated: sum(d.orders.created, 'openings'),
      ordersClosed: d.orders.closed.length,
      openingsClosed: sum(d.orders.closed, 'openings'),
      ordersChanged: d.orders.changed.length,
      occurrences: d.attendance.logged.length,
      headcountFrom: sum(d.headcount, 'from'),
      headcountTo: sum(d.headcount, 'to'),
      openSlotsFrom: sum(d.openSlots, 'from'),
      openSlotsTo: sum(d.openSlots, 'to')
    };
  }
  function changed(c) {
    return !!(c && (c.started || c.ended || c.wtScheduled || c.wtRescheduled || c.wtCompleted ||
      c.wtCancelled || c.ordersCreated || c.ordersClosed || c.ordersChanged || c.occurrences ||
      c.openSlotsFrom !== c.openSlotsTo));
  }

  /* Keep only what `keep(item)` allows -- the server's market check -- and recount.
     Every list item carries `location` (the building) for exactly this. */
  function filterDiff(d, keep) {
    var out = JSON.parse(JSON.stringify(d));
    ['assignments', 'walkthroughs', 'orders', 'attendance'].forEach(function (g) {
      Object.keys(out[g]).forEach(function (k) { out[g][k] = out[g][k].filter(keep); });
    });
    out.headcount = out.headcount.filter(keep);
    out.openSlots = out.openSlots.filter(keep);
    out.counts = counts(out);
    return out;
  }

  /* ---------- the history index ----------
     A list of uploads, newest last. Anything older than the retention window is
     dropped -- except the newest, which is kept however old it is, because it is
     what the next upload has to be compared with. A workbook nobody touched for
     ten days must not leave the next upload with nothing to compare against. */
  function prune(entries, now, days) {
    var list = (entries || []).slice().sort(function (x, y) {
      return String(x.takenAt).localeCompare(String(y.takenAt));
    });
    var cutoff = (now == null ? Date.now() : Number(new Date(now))) - (days || RETENTION_DAYS) * DAY_MS;
    var keep = [], drop = [];
    list.forEach(function (e, i) {
      if (i === list.length - 1 || Date.parse(e.takenAt) >= cutoff) keep.push(e);
      else drop.push(e);
    });
    return { keep: keep, drop: drop };
  }

  /* The upload to compare against for a window starting at `since`: the newest
     one taken at or before it, so the comparison covers the whole window. When
     history does not reach back that far, the oldest kept upload is the best
     available, and `partial` says so. */
  function baselineFor(entries, since) {
    var list = (entries || []).slice().sort(function (x, y) {
      return String(x.takenAt).localeCompare(String(y.takenAt));
    });
    if (!list.length) return null;
    var t = Date.parse(since);
    var before = list.filter(function (e) { return Date.parse(e.takenAt) <= t; });
    if (before.length) return { entry: before[before.length - 1], partial: false };
    return { entry: list[0], partial: true };
  }

  function idFor(takenAt, hash) {
    return String(takenAt).replace(/[^0-9]/g, '').slice(0, 14) + '-' + String(hash || '').slice(0, 8);
  }

  var api = {
    VERSION: VERSION, RETENTION_DAYS: RETENTION_DAYS,
    nameKey: nameKey, stageOf: stageOf,
    snapshot: snapshot, diff: diff, filterDiff: filterDiff, changed: changed,
    prune: prune, baselineFor: baselineFor, idFor: idFor
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlxHistory = api;
})(this);
