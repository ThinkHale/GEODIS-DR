/* GEODIS Management Suite -- what changed in the PLX workbook between uploads.
 *
 * The workbook is overwritten in place on SharePoint, so on its own it can only
 * say what is true now. Every upload is therefore reduced to a small snapshot of
 * the things a staffing meeting asks about, and two snapshots are compared:
 *
 *   "<site> - HC"           one row per associate on assignment, keyed by EID,
 *                           plus the Expected / Onsite / Short figures in the
 *                           header of each shift block
 *   WT List / Pipeline /    one row per candidate. They move between these tabs
 *   STARTED / DNR tabs      as they progress, so a candidate is followed by name
 *                           across all of them rather than per tab. A nameless
 *                           row on the WT List is an opening nobody fills yet
 *   "Beeline Reqs"          one row per open order, keyed by Req #
 *   "Attendance"            one row per occurrence
 *   "Geodis Key"            which customers each site has, by account number
 *
 * The workbook records state, never events, so every "event" here is inferred
 * from two states. The definitions are deliberately literal, so the numbers can
 * be explained in the meeting they are read out in:
 *
 *   assignment started      an EID on an HC tab that was not on any HC tab before
 *   assignment ended        an EID that has left every HC tab
 *   walkthrough scheduled   a candidate whose WT date was blank (or who is new)
 *   walkthrough rescheduled a WT date that changed from one value to another
 *   accepted for WT         a candidate row newly highlighted green
 *   approved for start      a candidate row newly highlighted blue
 *   walkthrough completed   a candidate who has moved onto a STARTED tab
 *   walkthrough cancelled   a candidate who has moved onto a DNR / cancelled tab
 *   order created           a Req # that was not on the Beeline Reqs tab before
 *   order filled / closed   a Req # that has left the tab. The sheet does not say
 *                           which, and the sync already treats it as closed
 *
 * Green and blue are the team's convention, not anything the sheet enforces, so
 * other colours are reported by name and never given a meaning.
 *
 * No DOM access and no storage: the Cloud Function stores and loads snapshots,
 * this only builds and compares them. Keep functions/plx-history-core.js
 * identical to this file.
 */
(function (root) {
  'use strict';

  /* 2 added customers, positions, highlights, site figures and weekly starts;
     3 added every WT List row, for open positions. An older snapshot still
     compares; only what it lacks is left out. */
  var VERSION = 3;
  var RETENTION_DAYS = 7;
  // The headcount series is a few hundred bytes a reading, so it keeps years.
  var SERIES_DAYS = 2 * 366;
  var DAY_MS = 24 * 60 * 60 * 1000;

  var HC_SHEET = /HC$/;
  var REQ_SHEET = /beeline\s*reqs/i;
  var KEY_SHEET = /geodis\s*key/i;
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

  /* What a highlight means on the candidate tabs. Only these two carry meaning;
     every other colour is kept under its own name. */
  var HIGHLIGHT_MEANS = { green: 'accepted', blue: 'approved' };
  /* A named WT List row that does not count as identified, and why. Taken from
     the comments the team writes on those rows: red is "not a good fit", orange
     a no-show being rescheduled, yellow "when a spot comes available". */
  var NOT_IDENTIFIED = { red: 'notFit', orange: 'noShow', yellow: 'waiting' };

  /* Job titles and Beeline job types, grouped the way the meeting talks about
     them. MATH1-3 are material handler levels; OPR, OPEPJ and the truck types
     are operators. Anything else keeps its own title rather than being forced in. */
  var POSITIONS = [
    { name: 'Material Handler', re: /math|material|handler|picker|^mh\b/i },
    { name: 'Operator', re: /^op|opr|operator|opeator|epj|pallet|reach|sit\s*down|forklift/i }
  ];

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
  function positionOf() {
    for (var a = 0; a < arguments.length; a++) {
      var s = txt(arguments[a]);
      if (!s) continue;
      for (var i = 0; i < POSITIONS.length; i++) if (POSITIONS[i].re.test(s)) return POSITIONS[i].name;
    }
    for (var b = 0; b < arguments.length; b++) if (txt(arguments[b])) return txt(arguments[b]);
    return 'Unspecified';
  }

  // Meeting columns: Material Handler, Operator, and everything else.
  function groupOf(position) {
    return position === 'Material Handler' ? 'mh' : position === 'Operator' ? 'op' : 'other';
  }
  /* Open positions summed over profile rows: { mh, op, other } of
     { open, identified, needed }, plus totals. */
  function openPositions(rows) {
    var out = { mh: { open: 0, identified: 0 }, op: { open: 0, identified: 0 }, other: { open: 0, identified: 0 },
      excluded: { notFit: 0, noShow: 0, waiting: 0, withdrawn: 0 } };
    (rows || []).forEach(function (r) {
      ['mh', 'op', 'other'].forEach(function (g) {
        out[g].open += (r.wt && r.wt[g].open) || 0;
        out[g].identified += (r.wt && r.wt[g].identified) || 0;
      });
      Object.keys(out.excluded).forEach(function (k) { out.excluded[k] += (r.wtExcluded && r.wtExcluded[k]) || 0; });
    });
    ['mh', 'op', 'other'].forEach(function (g) { out[g].needed = Math.max(0, out[g].open - out[g].identified); });
    out.open = out.mh.open + out.op.open + out.other.open;
    out.identified = out.mh.identified + out.op.identified + out.other.identified;
    out.needed = out.mh.needed + out.op.needed + out.other.needed;
    return out;
  }

  /* ---------- highlight colours ----------
     Classified by hue, so the several greens Excel offers all read as green. */
  function colorName(rgb) {
    var hex = String(rgb || '').replace(/^#/, '').slice(-6);
    if (!/^[0-9a-f]{6}$/i.test(hex)) return '';
    var r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255,
      b = parseInt(hex.slice(4, 6), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (d < 0.04 || l > 0.97) return '';            // white, grey, black
    var s = d / (1 - Math.abs(2 * l - 1));
    if (s < 0.15) return '';
    var h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    if (h < 15 || h >= 345) return 'red';
    if (h < 50) return 'orange';   // Excel's standard orange, FFC000, is 45 degrees
    if (h < 70) return 'yellow';
    if (h < 170) return 'green';
    if (h < 260) return 'blue';
    return 'pink';
  }
  /* The colour of each row of a worksheet, as [row index] -> hex, relative to the
     sheet's first row the way sheet_to_json numbers them. Needs the workbook read
     with { cellStyles: true }. The row's most common fill wins, so one stray
     highlighted cell does not recolour the row. */
  function rowFills(ws, XLSX) {
    var out = [];
    if (!ws || !ws['!ref']) return out;
    var range = XLSX.utils.decode_range(ws['!ref']);
    for (var R = range.s.r; R <= range.e.r; R++) {
      var tally = {}, best = '', bestN = 0;
      for (var C = range.s.c; C <= Math.min(range.e.c, range.s.c + 12); C++) {
        var c = ws[XLSX.utils.encode_cell({ r: R, c: C })];
        var fg = c && c.s && c.s.patternType === 'solid' && c.s.fgColor && c.s.fgColor.rgb;
        if (!fg) continue;
        tally[fg] = (tally[fg] || 0) + 1;
        if (tally[fg] > bestN) { bestN = tally[fg]; best = fg; }
      }
      out[R - range.s.r] = best;
    }
    return out;
  }

  /* ---------- dates ---------- */
  /* Start dates are typed by hand: "8/24/26", "08/24/2026 @7am", "22-Sep",
     "Pending". The year, when missing, comes from the tab name. */
  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function parseDay(v, yearHint) {
    var s = txt(v), m, y;
    if ((m = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/))) {
      y = m[3] ? Number(m[3]) : yearHint;
      if (!y) return null;
      if (y < 100) y += 2000;
      return utc(y, Number(m[1]) - 1, Number(m[2]));
    }
    if ((m = s.match(/(\d{1,2})[-\s]([a-z]{3})/i)) && MONTHS[m[2].toLowerCase()] != null && yearHint) {
      return utc(yearHint, MONTHS[m[2].toLowerCase()], Number(m[1]));
    }
    return null;
  }
  function utc(y, mo, d) {
    var t = Date.UTC(y, mo, d);
    var x = new Date(t);
    return x.getUTCMonth() === mo && x.getUTCDate() === d ? x : null;
  }
  function isoDay(d) { return d.toISOString().slice(0, 10); }
  // The Monday a date's week starts on, as YYYY-MM-DD.
  function weekOf(date) {
    var d = typeof date === 'string' ? new Date(date.length === 10 ? date + 'T00:00:00Z' : date) : date;
    if (!d || isNaN(d.getTime())) return '';
    var day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    return isoDay(day);
  }

  /* ---------- the Geodis Key: who the customers are ---------- */
  function readCustomers(sheets, ShiftKey) {
    var byNum = {}, bySite = {};
    var sheet = sheets.filter(function (s) { return KEY_SHEET.test(s.name); })[0];
    if (!sheet || !ShiftKey) return { byNum: byNum, bySite: bySite };
    (ShiftKey.parseShiftKey(sheet.aoa).entries || []).forEach(function (e) {
      var name = customerName(e.account);
      if (!name || !e.building) return;
      if (e.accountNum) byNum[e.building + '|' + e.accountNum] = name;
      var list = bySite[e.building] || (bySite[e.building] = []);
      if (list.indexOf(name) === -1) list.push(name);
    });
    return { byNum: byNum, bySite: bySite };
  }
  function customerName(v) { return txt(v).toUpperCase(); }
  /* One spelling per customer at a site. The Key's account number is the most
     reliable; then the Key's own spelling of the name; then a site with only one
     customer, where there is nobody else it could be. */
  function resolveCustomer(customers, site, accountNum, name) {
    var byNum = customers.byNum[site + '|' + txt(accountNum)];
    if (byNum) return byNum;
    var named = customerName(name);
    var known = customers.bySite[site] || [];
    if (named) {
      var squash = function (x) { return x.replace(/[^A-Z0-9]/g, ''); };
      for (var i = 0; i < known.length; i++) if (squash(known[i]) === squash(named)) return known[i];
      // An abbreviation ("32 D" for 32 DEGREES), when it can only mean one of them.
      var starts = known.filter(function (k) { return squash(named).length >= 2 && squash(k).indexOf(squash(named)) === 0; });
      if (starts.length === 1) return starts[0];
      return named;
    }
    if (known.length === 1) return known[0];
    // An account the Key does not list still names somebody; say which.
    return txt(accountNum) ? 'ACCT ' + txt(accountNum) : '';
  }

  /* ---------- the HC tabs ----------
     Read independently of shift-key.js's parseHeadcount, which drops anybody with
     no shift -- correct for shift tags, wrong here, where a new start nobody has
     given a shift yet is exactly the person the meeting wants to hear about. */
  function readRoster(sheets, customers, ShiftKey) {
    var roster = {}, sites = {};
    sheets.forEach(function (sheet) {
      if (!HC_SHEET.test(sheet.name)) return;
      var building = (sheet.name.match(/^(\d+)/) || [])[1] || '';
      var aoa = sheet.aoa || [];
      var site = sites[building] || (sites[building] = { location: building, sheet: sheet.name,
        expected: null, onsite: null, short: null });
      for (var h = 0; h < Math.min(aoa.length, 8); h++) {
        var headers = (aoa[h] || []).map(txt);
        var starts = [];
        headers.forEach(function (x, i) { if (NAME_HEADER.test(x)) starts.push(i); });
        if (!starts.length) continue;
        // Expected / Onsite / Short: labels on the row above, figures on this one.
        var labels = (aoa[h - 1] || []).map(txt);
        labels.forEach(function (label, i) {
          var k = /^expected$/i.test(label) ? 'expected' : /^onsite$/i.test(label) ? 'onsite'
            : /^short$/i.test(label) ? 'short' : '';
          var n = Number(txt(headers[i]));
          if (k && txt(headers[i]) !== '' && isFinite(n)) site[k] = (site[k] || 0) + n;
        });
        starts.forEach(function (start, b) {
          var end = b + 1 < starts.length ? starts[b + 1] : headers.length;
          var block = headers.slice(start, end);
          var col = {
            eid: start + Math.max(1, pick(block, /^eid$/i)),
            startDate: start + Math.max(2, pick(block, /start\s*date/i)),
            shift: start + Math.max(3, pick(block, /^shift$/i)),
            comments: start + pick(block, /^comments?$/i),
            dept: /dept|profit/i.test(headers[start - 1] || '') ? start - 1 : -1
          };
          if (col.comments < start) col.comments = -1;
          aoa.slice(h + 1).forEach(function (row) {
            var cells = row || [];
            var name = cell(cells, start), eid = cell(cells, col.eid).toUpperCase();
            if (!name || !/^\d+-/.test(eid)) return;
            if (roster[eid]) return;   // listed twice: the first row stands
            var dept = cell(cells, col.dept);
            roster[eid] = {
              eid: eid, name: name, location: building, site: sheet.name,
              customer: resolveCustomer(customers, building,
                ShiftKey && dept ? ShiftKey.accountNumOf(dept) : '', ''),
              shift: cell(cells, col.shift), startDate: cell(cells, col.startDate),
              comments: cell(cells, col.comments)
            };
          });
        });
        break;
      }
    });
    return { roster: roster, sites: sites };
  }

  /* ---------- the candidate tabs ---------- */
  function readCandidates(sheets, customers) {
    var people = {}, openSlots = {}, slots = [], starts = {}, wtRows = [];
    sheets.forEach(function (sheet) {
      var stage = stageOf(sheet.name);
      if (!stage) return;
      var yearHint = Number((sheet.name.match(/20\d\d/) || [])[0]) || 0;
      var aoa = sheet.aoa || [], fills = sheet.fills || [];
      for (var h = 0; h < Math.min(aoa.length, 6); h++) {
        var headers = (aoa[h] || []).map(txt);
        var col = {
          name: pick(headers, CANDIDATE_NAME),
          building: pick(headers, /^b\w*ilding$/i),   // "Biuilding" on one tab
          account: pick(headers, /^account$/i),
          position: pick(headers, /^position$/i),
          fn: pick(headers, /function/i),
          shift: pick(headers, /^shift$/i),
          startDate: pick(headers, /^start\s*date$/i),
          wtDate: pick(headers, /^wt\s*date/i)
        };
        if (col.name === -1) continue;
        aoa.slice(h + 1).forEach(function (row, i) {
          var cells = row || [];
          var name = cell(cells, col.name), building = cell(cells, col.building);
          var customer = resolveCustomer(customers, building, '', cell(cells, col.account));
          var position = positionOf(cell(cells, col.position), cell(cells, col.fn));
          var color = colorName(fills[h + 1 + i]);
          // Every WT List row is one opening, named or not.
          if (stage === 'openings' && building) {
            wtRows.push({ location: building, customer: customer, position: position,
              name: name, key: name ? nameKey(name) : '', color: color });
          }
          if (!name) {
            // A named position with nobody in it yet: an unfilled walkthrough slot.
            // Its colour is kept but given no meaning -- on the WT List, green has
            // been seen on new orders nobody is lined up for yet.
            if (stage === 'openings' && building) {
              openSlots[building] = (openSlots[building] || 0) + 1;
              slots.push({ location: building, customer: customer, position: position,
                shift: cell(cells, col.shift), color: color });
            }
            return;
          }
          if (stage === 'started') {
            // Every row counts here, rehires included: this is the start log.
            var day = parseDay(cell(cells, col.startDate), yearHint);
            if (day) {
              var k = weekOf(day) + '|' + building;
              starts[k] = (starts[k] || 0) + 1;
            }
          }
          var key = nameKey(name);
          if (!key) return;
          var prior = people[key];
          if (prior && STAGE_RANK[prior.stage] >= STAGE_RANK[stage]) return;
          people[key] = {
            key: key, name: name, stage: stage, tab: sheet.name, location: building,
            account: cell(cells, col.account), customer: customer, position: position,
            shift: cell(cells, col.shift), startDate: cell(cells, col.startDate),
            wtDate: cell(cells, col.wtDate), color: color, highlight: HIGHLIGHT_MEANS[color] || ''
          };
        });
        break;
      }
    });
    return {
      people: people, openSlots: openSlots, slots: slots, wtRows: wtRows,
      starts: Object.keys(starts).sort().map(function (k) {
        var p = k.split('|');
        return { week: p[0], location: p[1], count: starts[k] };
      })
    };
  }

  /* ---------- the Beeline Reqs tab ----------
     Parsed by shift-key.js, which the sync already trusts with these rows. */
  function readOrders(sheets, ShiftKey, customers) {
    var orders = {};
    var sheet = sheets.filter(function (s) { return REQ_SHEET.test(s.name); })[0];
    if (!sheet || !ShiftKey) return orders;
    ShiftKey.parseRequisitions(sheet.aoa).rows.forEach(function (r) {
      orders[r.reqNumber] = {
        req: r.reqNumber, location: r.building, account: r.account,
        customer: resolveCustomer(customers, r.building, r.accountNum, r.account),
        position: positionOf(r.jobType, r.jobFunction),
        shift: r.shift, jobType: r.jobType, jobFunction: r.jobFunction,
        hireDate: r.hireDate, openings: r.openings
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
     [{ name, aoa }] list the sync already builds, so the workbook is read once;
     a sheet may also carry `fills` (see rowFills) for the highlight colours. */
  function snapshot(sheets, opts) {
    opts = opts || {};
    sheets = sheets || [];
    var customers = readCustomers(sheets, opts.ShiftKey);
    var candidates = readCandidates(sheets, customers);
    var hc = readRoster(sheets, customers, opts.ShiftKey);
    return {
      version: VERSION,
      takenAt: opts.takenAt || new Date().toISOString(),
      highlights: sheets.some(function (s) { return s.fills && s.fills.length; }),
      customers: customers.bySite,
      sites: hc.sites,
      roster: hc.roster,
      candidates: candidates.people,
      openSlots: candidates.openSlots,
      slots: candidates.slots,
      wtRows: candidates.wtRows,
      starts: candidates.starts,
      orders: readOrders(sheets, opts.ShiftKey, customers),
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
      walkthroughs: { scheduled: [], rescheduled: [], accepted: [], approved: [], completed: [], cancelled: [] },
      orders: { created: [], closed: [], changed: [] },
      attendance: { logged: [] },
      headcount: [],
      openSlots: []
    };
    var ra = a.roster || {}, rb = b.roster || {};
    Object.keys(ra).forEach(function (k) { if (!rb[k]) out.assignments.started.push(ra[k]); });
    Object.keys(rb).forEach(function (k) { if (!ra[k]) out.assignments.ended.push(rb[k]); });

    // A highlight can only be "new" when the earlier upload was read for them.
    var colours = !!(b.highlights && a.highlights);
    var ca = a.candidates || {}, cb = b.candidates || {};
    Object.keys(ca).forEach(function (k) {
      var now = ca[k], was = cb[k];
      if (now.wtDate && (!was || !was.wtDate) && now.stage !== 'cancelled') out.walkthroughs.scheduled.push(now);
      else if (now.wtDate && was && was.wtDate && now.wtDate !== was.wtDate) {
        out.walkthroughs.rescheduled.push(Object.assign({}, now, { fromWtDate: was.wtDate }));
      }
      // Only while they are still a candidate: the STARTED tab is blue throughout,
      // and moving there is already reported as completed.
      var candidate = now.stage === 'openings' || now.stage === 'pipeline';
      if (colours && candidate && now.highlight && (!was || was.highlight !== now.highlight)) {
        out.walkthroughs[now.highlight].push(now);
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

    /* Per building: how many before and after, and the people behind the net. Five
       gone and three new reads as "-2" on a total; the meeting needs all three. */
    var tally = function (list) {
      var n = {};
      list.forEach(function (p) { n[p.location] = (n[p.location] || 0) + 1; });
      return n;
    };
    var hb = tally(values(rb)), ha = tally(values(ra));
    var added = tally(out.assignments.started), removed = tally(out.assignments.ended);
    Object.keys(Object.assign({}, hb, ha)).sort().forEach(function (loc) {
      out.headcount.push({ location: loc, from: hb[loc] || 0, to: ha[loc] || 0,
        added: added[loc] || 0, removed: removed[loc] || 0 });
    });
    var sb = b.openSlots || {}, sa = a.openSlots || {};
    Object.keys(Object.assign({}, sb, sa)).sort().forEach(function (loc) {
      out.openSlots.push({ location: loc, from: sb[loc] || 0, to: sa[loc] || 0 });
    });

    [out.assignments, out.walkthroughs, out.orders, out.attendance].forEach(function (group) {
      Object.keys(group).forEach(function (k) { group[k].sort(byLocationThenName); });
    });
    out.highlights = colours;
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
      wtAccepted: (d.walkthroughs.accepted || []).length,
      wtApproved: (d.walkthroughs.approved || []).length,
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
    return !!(c && (c.started || c.ended || c.wtScheduled || c.wtRescheduled || c.wtAccepted ||
      c.wtApproved || c.wtCompleted || c.wtCancelled || c.ordersCreated || c.ordersClosed ||
      c.ordersChanged || c.occurrences || c.openSlotsFrom !== c.openSlotsTo));
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

  /* ---------- where things stand: one snapshot, by site and customer ----------
     The unit is a customer AT a site ("1517 · FERADYNE"), because a site has
     several customers and a customer can be at several sites, and because the
     market check is by site. Totals by customer or position are sums of these. */
  function profile(snap) {
    snap = snap || {};
    var rows = {};
    var row = function (loc, customer) {
      // A repeated header row ("Building") or a note in the column is no site.
      if (!/^\d/.test(String(loc || ''))) loc = '';
      var k = loc + '|' + (customer || '');
      return rows[k] || (rows[k] = { location: loc, customer: customer || '', onRoster: 0,
        orders: 0, openings: 0, openSlots: 0, candidates: 0, accepted: 0, approved: 0,
        openingsByPosition: {}, slotsByPosition: {}, candidatesByPosition: {}, reqs: [], otherColors: {},
        slotColors: {}, wt: { mh: { open: 0, identified: 0 }, op: { open: 0, identified: 0 }, other: { open: 0, identified: 0 } },
        wtExcluded: { notFit: 0, noShow: 0, waiting: 0, withdrawn: 0 } });
    };
    var add = function (map, k, n) { map[k] = (map[k] || 0) + n; };
    values(snap.roster).forEach(function (p) { row(p.location, p.customer).onRoster++; });
    values(snap.orders).forEach(function (o) {
      var r = row(o.location, o.customer);
      r.orders++; r.openings += Number(o.openings) || 0;
      add(r.openingsByPosition, o.position || 'Unspecified', Number(o.openings) || 0);
      r.reqs.push(o.req);
    });
    (snap.slots || []).forEach(function (s) {
      var r = row(s.location, s.customer);
      r.openSlots++; add(r.slotsByPosition, s.position || 'Unspecified', 1);
      if (s.color) add(r.slotColors, s.color, 1);
    });
    // Identified: named on the WT List or the Pipeline, not yet started or out.
    values(snap.candidates).forEach(function (c) {
      if (c.stage !== 'openings' && c.stage !== 'pipeline') return;
      var r = row(c.location, c.customer);
      r.candidates++; add(r.candidatesByPosition, c.position || 'Unspecified', 1);
      if (c.highlight) r[c.highlight]++;
      else if (c.color) add(r.otherColors, c.color, 1);
    });
    /* Open positions, the way the meeting counts them: every WT List row is an
       opening, and a named row is identified unless it is red, orange or yellow,
       or the person has since been withdrawn onto a DNR / cancelled tab. Colours
       only count when this snapshot was read for them. */
    (snap.wtRows || []).forEach(function (w) {
      var r = row(w.location, w.customer), g = r.wt[groupOf(w.position)];
      g.open++;
      if (!w.name) return;
      var c = snap.candidates && snap.candidates[w.key];
      var reason = c && c.stage === 'cancelled' ? 'withdrawn' : snap.highlights ? NOT_IDENTIFIED[w.color] : '';
      if (reason) r.wtExcluded[reason]++;
      else g.identified++;
    });
    var customers = snap.customers || {};
    Object.keys(customers).forEach(function (loc) { customers[loc].forEach(function (c) { row(loc, c); }); });

    var sites = {};
    values(snap.sites).forEach(function (s) {
      // "1500 - Lindt HC" is Lindt; "1502 - HC" has no name of its own.
      var label = String(s.sheet || '').replace(/^\d+\s*-?\s*/, '').replace(/\s*HC$/i, '').trim();
      sites[s.location] = Object.assign({ onRoster: 0, label: label }, s);
    });
    values(rows).forEach(function (r) {
      var s = sites[r.location] || (sites[r.location] = { location: r.location, sheet: '', expected: null,
        onsite: null, short: null, onRoster: 0 });
      s.onRoster += r.onRoster;
    });
    var sort = function (x, y) {
      return String(x.location).localeCompare(String(y.location)) || String(x.customer || '').localeCompare(String(y.customer || ''));
    };
    return {
      takenAt: snap.takenAt || '',
      highlights: !!snap.highlights,
      rows: values(rows).filter(function (r) { return r.location; }).sort(sort),
      sites: values(sites).filter(function (s) { return /^\d/.test(String(s.location || '')); }).sort(sort),
      starts: (snap.starts || []).slice()
    };
  }
  function filterProfile(p, keep) {
    var out = JSON.parse(JSON.stringify(p));
    out.rows = out.rows.filter(keep);
    out.sites = out.sites.filter(keep);
    out.starts = out.starts.filter(keep);
    return out;
  }

  /* ---------- headcount over time ----------
     The kept files last a week; this lasts years. One reading per stored upload:
     the roster size and expected figure at each site, and who was added and
     removed since the reading before. */
  function seriesPoint(snap, d) {
    var sites = {};
    values(snap.roster).forEach(function (p) {
      var s = sites[p.location] || (sites[p.location] = { onRoster: 0, added: 0, removed: 0 });
      s.onRoster++;
    });
    values(snap.sites).forEach(function (s) {
      var x = sites[s.location] || (sites[s.location] = { onRoster: 0, added: 0, removed: 0 });
      if (s.expected != null) x.expected = s.expected;
    });
    ((d && d.headcount) || []).forEach(function (h) {
      var x = sites[h.location] || (sites[h.location] = { onRoster: 0, added: 0, removed: 0 });
      x.added = h.added || 0; x.removed = h.removed || 0;
    });
    // Open positions too, so they can be reported on over time like headcount.
    if (snap.wtRows) {
      var byLoc = {};
      profile(snap).rows.forEach(function (r) { (byLoc[r.location] = byLoc[r.location] || []).push(r); });
      Object.keys(byLoc).forEach(function (loc) {
        var o = openPositions(byLoc[loc]);
        if (!o.open) return;
        var x = sites[loc] || (sites[loc] = { onRoster: 0, added: 0, removed: 0 });
        x.open = o.open; x.identified = o.identified;
        x.mhOpen = o.mh.open; x.mhIdentified = o.mh.identified; x.opOpen = o.op.open; x.opIdentified = o.op.identified;
      });
    }
    return { takenAt: snap.takenAt, sites: sites };
  }
  function pruneSeries(points, now) {
    var cutoff = (now == null ? Date.now() : Number(new Date(now))) - SERIES_DAYS * DAY_MS;
    return (points || []).filter(function (p) { return Date.parse(p.takenAt) >= cutoff; })
      .sort(function (x, y) { return String(x.takenAt).localeCompare(String(y.takenAt)); });
  }
  function filterSeries(points, keep) {
    return (points || []).map(function (p) {
      var sites = {};
      Object.keys(p.sites || {}).forEach(function (loc) { if (keep({ location: loc })) sites[loc] = p.sites[loc]; });
      return { takenAt: p.takenAt, sites: sites };
    });
  }
  /* Week by week (Monday to Sunday): headcount at the end of each week, carried
     forward from the last reading when nothing was uploaded that week, and the
     people added and removed during it. Newest week last. */
  function weekly(points, opts) {
    opts = opts || {};
    var list = (points || []).slice().sort(function (x, y) { return String(x.takenAt).localeCompare(String(y.takenAt)); });
    if (!list.length) return [];
    var last = weekOf(opts.now ? new Date(opts.now) : new Date());
    var first = weekOf(list[0].takenAt);
    var weeks = [];
    for (var w = first; w <= last; w = isoDay(new Date(Date.parse(w + 'T00:00:00Z') + 7 * DAY_MS))) weeks.push(w);
    weeks = weeks.slice(-(opts.weeks || 12));
    var out = [], i = 0, latest = null;
    var startOfFirst = weeks[0];
    while (i < list.length && weekOf(list[i].takenAt) < startOfFirst) latest = list[i++];
    weeks.forEach(function (week) {
      var row = { week: week, sites: {}, onRoster: 0, expected: null, added: 0, removed: 0, readings: 0 };
      while (i < list.length && weekOf(list[i].takenAt) === week) {
        var p = list[i++];
        row.readings++;
        Object.keys(p.sites || {}).forEach(function (loc) {
          var s = row.sites[loc] || (row.sites[loc] = { added: 0, removed: 0 });
          s.added += p.sites[loc].added || 0; s.removed += p.sites[loc].removed || 0;
        });
        latest = p;
      }
      if (latest) {
        Object.keys(latest.sites || {}).forEach(function (loc) {
          var s = row.sites[loc] || (row.sites[loc] = { added: 0, removed: 0 });
          s.onRoster = latest.sites[loc].onRoster || 0;
          if (latest.sites[loc].expected != null) s.expected = latest.sites[loc].expected;
          if (latest.sites[loc].open != null) { s.open = latest.sites[loc].open; s.identified = latest.sites[loc].identified || 0; }
        });
      }
      Object.keys(row.sites).forEach(function (loc) {
        var s = row.sites[loc];
        row.onRoster += s.onRoster || 0;
        row.added += s.added; row.removed += s.removed;
        if (s.open != null) { row.open = (row.open || 0) + s.open; row.identified = (row.identified || 0) + s.identified; }
        if (s.expected != null) row.expected = (row.expected || 0) + s.expected;
      });
      row.known = !!latest;
      out.push(row);
    });
    out.forEach(function (r, k) {
      var prev = out[k - 1];
      r.change = prev && prev.known && r.known ? r.onRoster - prev.onRoster : null;
      Object.keys(r.sites).forEach(function (loc) {
        var ps = prev && prev.known && prev.sites[loc];
        r.sites[loc].change = ps && ps.onRoster != null && r.sites[loc].onRoster != null
          ? r.sites[loc].onRoster - ps.onRoster : null;
      });
    });
    return out;
  }

  /* ---------- several markets at once ----------
     Each market's workbook is compared only with its own uploads; "All markets"
     is the sum of those comparisons, never one market's upload against
     another's. Site numbers do not repeat across markets, so lists simply join. */
  function mergeDiffs(list) {
    list = (list || []).filter(Boolean);
    if (!list.length) return null;
    var out = JSON.parse(JSON.stringify(list[0]));
    list.slice(1).forEach(function (d) {
      ['assignments', 'walkthroughs', 'orders', 'attendance'].forEach(function (g) {
        Object.keys(d[g] || {}).forEach(function (k) { out[g][k] = (out[g][k] || []).concat(d[g][k]); });
      });
      out.headcount = out.headcount.concat(d.headcount || []);
      out.openSlots = out.openSlots.concat(d.openSlots || []);
      out.highlights = out.highlights && d.highlights;
    });
    out.counts = counts(out);
    return out;
  }
  function mergeProfiles(list) {
    list = (list || []).filter(Boolean);
    if (!list.length) return null;
    var sort = function (x, y) {
      return String(x.location).localeCompare(String(y.location)) || String(x.customer || '').localeCompare(String(y.customer || ''));
    };
    return {
      takenAt: list.map(function (p) { return p.takenAt; }).sort().pop(),
      highlights: list.some(function (p) { return p.highlights; }),
      rows: [].concat.apply([], list.map(function (p) { return p.rows; })).sort(sort),
      sites: [].concat.apply([], list.map(function (p) { return p.sites; })).sort(sort),
      starts: [].concat.apply([], list.map(function (p) { return p.starts || []; }))
    };
  }
  /* Weekly rows from several markets, by week. A market with no reading yet in
     a week adds nothing to it; a change is only summed where it is known. */
  function mergeWeekly(lists) {
    var byWeek = {};
    (lists || []).forEach(function (weeks) {
      (weeks || []).forEach(function (w) {
        var x = byWeek[w.week] || (byWeek[w.week] = { week: w.week, sites: {}, onRoster: 0, expected: null,
          added: 0, removed: 0, readings: 0, known: false, change: null });
        Object.keys(w.sites || {}).forEach(function (loc) { x.sites[loc] = w.sites[loc]; });
        if (!w.known) return;
        x.known = true;
        x.readings += w.readings || 0;
        x.onRoster += w.onRoster || 0; x.added += w.added || 0; x.removed += w.removed || 0;
        if (w.expected != null) x.expected = (x.expected || 0) + w.expected;
        if (w.open != null) { x.open = (x.open || 0) + w.open; x.identified = (x.identified || 0) + (w.identified || 0); }
        if (w.change != null) x.change = (x.change || 0) + w.change;
      });
    });
    return Object.keys(byWeek).sort().map(function (k) { return byWeek[k]; });
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
    VERSION: VERSION, RETENTION_DAYS: RETENTION_DAYS, SERIES_DAYS: SERIES_DAYS,
    nameKey: nameKey, stageOf: stageOf, positionOf: positionOf, colorName: colorName,
    groupOf: groupOf, openPositions: openPositions,
    rowFills: rowFills, parseDay: parseDay, weekOf: weekOf,
    snapshot: snapshot, diff: diff, filterDiff: filterDiff, changed: changed,
    profile: profile, filterProfile: filterProfile,
    mergeDiffs: mergeDiffs, mergeProfiles: mergeProfiles, mergeWeekly: mergeWeekly,
    seriesPoint: seriesPoint, pruneSeries: pruneSeries, filterSeries: filterSeries, weekly: weekly,
    prune: prune, baselineFor: baselineFor, idFor: idFor
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlxHistory = api;
})(this);
