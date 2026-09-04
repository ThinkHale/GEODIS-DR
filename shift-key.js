/* GEODIS Management Suite -- shift tags from the PLX workbook.
 *
 * The WFM weekly schedule only covers people who were actually rostered that
 * week, so anyone on the clock without a schedule row reads as "unscheduled"
 * even though everyone knows which shift they work. The PLX workbook already
 * records that, in two places:
 *
 *   "Geodis Key"   building + job + account -> shift label and its hours
 *   "<site> - HC"  one row per associate, with an EID and a Shift column
 *
 * So the HC tabs are the per-person assignment and the Key is the vocabulary
 * that says which shifts a building runs and when they are.
 *
 * IMPORTANT -- the EID is not a badge. WFM EIDs look like "80-LGRACH3897" while
 * the RC/Beeline roster is keyed by numeric badges like "215005". They are
 * separate namespaces with no overlap, so a shift record carries BOTH its EID
 * (which matches the on-premise report directly) and a name key (which is the
 * only bridge to a roster profile). See rosterKey() in schedule-core.js.
 *
 * No DOM access, so a scheduled Cloud Function can reuse this verbatim.
 */
(function (root) {
  'use strict';

  var KEY_SHEET = /geodis\s*key/i;
  var HC_SHEET = /HC$/;
  // Column headers in the Key tab's right-hand table. Matched by text, not
  // position, so a re-ordered or widened export keeps working.
  var KEY_COLS = {
    building: /^building$/i,
    job: /job title/i,
    account: /account name/i,
    accountNum: /account num/i,
    beelineShift: /beeline shift/i,
    shift: /^shift$/i,
    schedule: /^schedule$/i,
    supervisor: /supervisor/i
  };
  var NAME_HEADER = /^employee\s+name$/i;

  function txt(v) { return v == null ? '' : String(v).trim(); }
  function pickCol(headers, re) {
    for (var i = 0; i < headers.length; i++) if (re.test(headers[i])) return i;
    return -1;
  }

  /* ---------- clock strings ----------
     The Key writes hours in its own shorthand -- "6am", "2:30pm", "12am" -- which
     is not the "7:00 AM" the WFM export uses. */
  function parseLoose(v) {
    var m = txt(v).toLowerCase().replace(/\s+/g, '').match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
    if (!m) return null;
    var h = Number(m[1]) % 12;
    if (m[3] === 'pm') h += 12;
    var min = m[2] ? Number(m[2]) : 0;
    if (min > 59) return null;
    return h * 60 + min;
  }

  /* "6am-2:30pm Mon-Fri"                -> 360..870, Mon-Fri
     "Mon - Fri 8am - 4:30pm"            -> days first, same thing
     "3:30pm-12am Mon-Fri"               -> ends at midnight (1440, not 0)
     "Sun 11am - 7:30pm / Mon - Thurs …" -> two windows; the first is returned
                                            and `compound` is set

     A window is a convenience, not the point -- the shift TAG is what a profile
     carries. Anything unparseable returns null with the raw text kept, rather
     than a guessed set of hours. */
  function parseKeySchedule(v) {
    var raw = txt(v);
    if (!raw) return null;
    var compound = /[&/]|\band\b/i.test(raw);
    var first = raw.split(/\s*(?:&|\/|\band\b)\s*/i)[0];
    // A time range is the only thing we need out of it; the day words can sit
    // before or after, so find the times wherever they are.
    var times = first.match(/(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)/gi);
    if (!times || times.length < 2) return { raw: raw, start: null, end: null, compound: compound, days: dayPart(first) };
    var start = parseLoose(times[0]), end = parseLoose(times[1]);
    if (start == null || end == null) return { raw: raw, start: null, end: null, compound: compound, days: dayPart(first) };
    // "3:30pm-12am" ends AT midnight, it does not start the next day at 00:00.
    if (end === 0) end = 1440;
    var overnight = end <= start;
    if (overnight) end += 1440;
    return {
      raw: raw, start: start, end: end, overnight: overnight,
      hours: (end - start) / 60, compound: compound, days: dayPart(first)
    };
  }
  function dayPart(s) {
    var m = txt(s).match(/((?:sun|mon|tue|wed|thur?|fri|sat)[a-z]*)\s*(?:-|through|to)\s*((?:sun|mon|tue|wed|thur?|fri|sat)[a-z]*)/i);
    if (m) return m[1] + '-' + m[2];
    var one = txt(s).match(/\b(sun|mon|tue|wed|thur?|fri|sat)[a-z]*\b/i);
    return one ? one[0] : '';
  }

  /* ---------- the Key tab ----------
     Two independent tables sit side by side. The left one lists building
     addresses; the right one, found by its own header row, is the shift map. */
  function parseShiftKey(aoa) {
    // accounts: "building|accountNum" -> the client's name, so an associate's
    // dept code ("1502-18845") can be shown as a place rather than a number.
    var out = { entries: [], byBuilding: {}, windows: {}, byAccount: {}, accounts: {}, warnings: [] };
    var rows = aoa || [];
    var headerRow = -1, cols = null;
    for (var i = 0; i < Math.min(rows.length, 15); i++) {
      var headers = (rows[i] || []).map(txt);
      var c = {};
      Object.keys(KEY_COLS).forEach(function (k) { c[k] = pickCol(headers, KEY_COLS[k]); });
      if (c.building !== -1 && c.shift !== -1) { headerRow = i; cols = c; break; }
    }
    if (headerRow === -1) {
      out.warnings.push('No "Building" and "Shift" columns were found. Is this the "Geodis Key" tab?');
      return out;
    }

    rows.slice(headerRow + 1).forEach(function (row) {
      var cells = (row || []).map(txt);
      var building = cells[cols.building], shift = cells[cols.shift];
      if (!building || !shift) return;
      var entry = {
        building: building,
        job: cols.job !== -1 ? cells[cols.job] : '',
        account: cols.account !== -1 ? cells[cols.account] : '',
        accountNum: cols.accountNum !== -1 ? cells[cols.accountNum] : '',
        beelineShift: cols.beelineShift !== -1 ? cells[cols.beelineShift] : '',
        shift: shift,
        schedule: parseKeySchedule(cols.schedule !== -1 ? cells[cols.schedule] : ''),
        supervisor: cols.supervisor !== -1 ? cells[cols.supervisor] : ''
      };
      out.entries.push(entry);
      if (entry.accountNum && entry.account) out.accounts[building + '|' + entry.accountNum] = entry.account;

      if (!out.byBuilding[building]) out.byBuilding[building] = [];
      if (out.byBuilding[building].indexOf(shift) === -1) out.byBuilding[building].push(shift);
      // A building can run the same shift label on different hours for different
      // accounts. Collect every distinct window rather than letting the last row
      // win -- an ambiguous shift is reported, never resolved by guessing.
      var key = building + '|' + shift;
      var w = out.windows[key] || (out.windows[key] = []);
      var raw = entry.schedule ? entry.schedule.raw : '';
      if (raw && w.map(function (x) { return x.raw; }).indexOf(raw) === -1) w.push(entry.schedule);
      /* Also index by account. A building running one shift on two different
         sets of hours is not really ambiguous -- the hours belong to the CLIENT,
         and an associate's dept code says which client they are on. */
      if (raw && entry.accountNum) {
        var ak = building + '|' + entry.accountNum + '|' + shift;
        var aw = out.byAccount[ak] || (out.byAccount[ak] = []);
        if (aw.map(function (x) { return x.raw; }).indexOf(raw) === -1) aw.push(entry.schedule);
      }
    });

    Object.keys(out.byBuilding).forEach(function (b) { out.byBuilding[b].sort(); });
    Object.keys(out.windows).forEach(function (k) {
      if (out.windows[k].length > 1) {
        out.warnings.push('Building ' + k.split('|')[0] + ' shift "' + k.split('|')[1] + '" runs ' +
          out.windows[k].length + ' different sets of hours (' +
          out.windows[k].map(function (x) { return x.raw; }).join('; ') +
          '). Which one applies is decided by the account, taken from each ' +
          'associate\'s dept code.');
      }
    });
    return out;
  }

  // The unambiguous window for a building's shift, or null when there is none or
  // more than one.
  /* The hours for a shift, narrowed by account where the dept code gives one.
     Building + shift alone is ambiguous at sites running several clients on the
     same shift; building + account + shift almost never is. Falls back to the
     building-wide answer, and still returns null rather than choosing when even
     that has more than one. */
  function windowFor(key, building, shift, accountNum) {
    if (!key) return null;
    if (accountNum && key.byAccount) {
      var a = key.byAccount[building + '|' + accountNum + '|' + shift];
      if (a && a.length === 1) return a[0];
    }
    var w = key.windows ? key.windows[building + '|' + shift] : null;
    return w && w.length === 1 ? w[0] : null;
  }
  /* Dept codes on the HC tabs that do not exist in the Key, mapped to the account
     they were meant to be. These are typos at source -- 18070 for Replay's 18270
     is a transposition -- so the right fix is in the workbook. Correcting them
     here means the people on them are scheduled in the meantime rather than
     dropping out of coverage, and each use is reported so the list cannot rot
     unnoticed after the workbook is fixed. */
  var ACCOUNT_ALIASES = {
    '1517|18070': '18270',     // Replay
    /* 3 Nails. One digit off 18773, and 18773 itself carries a single person,
       so the five here read as that row mistyped. It matters: 18773's
       7am-3:30pm Mon-Fri is what six of 1517's seven accounts run, and only
       32 Degrees (18611) differs -- so even if the intended code were some
       other account, these hours would still be the answer. */
    '1517|18873': '18773'
  };
  function accountNumOf(dept) {
    var n = String(dept || '').split('-')[1];
    return n ? n.trim() : '';
  }
  function resolveAccount(building, accountNum) {
    return ACCOUNT_ALIASES[building + '|' + accountNum] || accountNum;
  }

  /* ---------- the HC tabs ----------
     Each sheet holds side-by-side shift blocks. A block is found by its
     "Employee  Name" header; the five columns after it are fixed. */
  function parseHeadcount(sheets, nameKeyOf) {
    var out = { people: [], warnings: [], sheets: [] };
    var seen = {};
    (sheets || []).forEach(function (sheet) {
      if (!HC_SHEET.test(sheet.name)) return;
      var building = (sheet.name.match(/^(\d+)/) || [])[1] || '';
      var aoa = sheet.aoa || [];
      var headerRow = -1, starts = [];
      for (var i = 0; i < Math.min(aoa.length, 8); i++) {
        var cand = (aoa[i] || []).map(txt).reduce(function (acc, h, idx) {
          if (NAME_HEADER.test(h)) acc.push(idx);
          return acc;
        }, []);
        if (cand.length) { headerRow = i; starts = cand; break; }
      }
      if (headerRow === -1) {
        out.warnings.push('"' + sheet.name + '" has no "Employee  Name" column and was skipped.');
        return;
      }
      out.sheets.push({ name: sheet.name, building: building, blocks: starts.length });

      starts.forEach(function (start) {
        aoa.slice(headerRow + 1).forEach(function (row) {
          var cells = (row || []).map(txt);
          var name = cells[start];
          if (!name) return;
          var eid = cells[start + 1] || '';
          var shift = cells[start + 3] || '';
          if (!shift) return;                       // nothing to tag them with
          var nk = nameKeyOf ? nameKeyOf(name) : '';
          // Same person listed twice (two blocks, or a stale row) -- keep the
          // first and say so rather than letting one silently overwrite another.
          var dedupe = eid || nk;
          if (!dedupe) return;
          if (seen[dedupe]) {
            if (seen[dedupe].shift !== shift) {
              out.warnings.push('"' + name + '" appears more than once with different shifts (' +
                seen[dedupe].shift + ' and ' + shift + '); the first is used.');
            }
            return;
          }
          var rec = {
            name: name, nameKey: nk, eid: eid, shift: shift,
            building: building, dept: cells[start - 1] || '',
            startDate: cells[start + 2] || '', sheet: sheet.name
          };
          seen[dedupe] = rec;
          out.people.push(rec);
        });
      });
    });
    return out;
  }

  /* ---------- open orders ----------
     The "Beeline Reqs" tab is the live list of open orders: one row per
     requisition, with the building, account, shift and how many are wanted.
     Headers carry trailing spaces in the sheet, so they are matched loosely. */
  var REQ_SHEET = /beeline\s*reqs/i;
  var REQ_COLS = {
    agency: /^agency$/i,
    building: /^building$/i,
    account: /account name/i,
    accountNum: /^account$/i,
    hireDate: /hire date/i,
    shift: /^shift$/i,
    jobType: /job type/i,
    reqNumber: /^req\s*#?$/i,
    quantity: /^quantity$/i,
    reportTo: /report to/i,
    jobFunction: /job function/i,
    notes: /^notes$/i
  };

  function parseRequisitions(aoa) {
    var out = { rows: [], warnings: [] };
    var rows = aoa || [];
    var headerRow = -1, cols = null;
    for (var i = 0; i < Math.min(rows.length, 10); i++) {
      var headers = (rows[i] || []).map(txt);
      var c = {};
      Object.keys(REQ_COLS).forEach(function (k) { c[k] = pickCol(headers, REQ_COLS[k]); });
      if (c.reqNumber !== -1 && c.quantity !== -1) { headerRow = i; cols = c; break; }
    }
    if (headerRow === -1) {
      out.warnings.push('No "Req #" and "Quantity" columns were found on the Beeline Reqs tab.');
      return out;
    }
    var seen = {};
    rows.slice(headerRow + 1).forEach(function (row) {
      var cells = (row || []).map(txt);
      var req = cells[cols.reqNumber];
      if (!req) return;
      if (seen[req]) {
        out.warnings.push('Req #' + req + ' appears more than once; the first row is used.');
        return;
      }
      seen[req] = true;
      var qty = Number(cells[cols.quantity]);
      out.rows.push({
        reqNumber: req,
        agency: cols.agency !== -1 ? cells[cols.agency] : '',
        building: cols.building !== -1 ? cells[cols.building] : '',
        account: cols.account !== -1 ? cells[cols.account] : '',
        accountNum: cols.accountNum !== -1 ? cells[cols.accountNum] : '',
        hireDate: cols.hireDate !== -1 ? cells[cols.hireDate] : '',
        shift: cols.shift !== -1 ? cells[cols.shift] : '',
        jobType: cols.jobType !== -1 ? cells[cols.jobType] : '',
        jobFunction: cols.jobFunction !== -1 ? cells[cols.jobFunction] : '',
        reportTo: cols.reportTo !== -1 ? cells[cols.reportTo] : '',
        notes: cols.notes !== -1 ? cells[cols.notes] : '',
        openings: isFinite(qty) && qty > 0 ? qty : 0
      });
    });
    return out;
  }

  /* An open order in the shape the Requisitions tab already uses.

     `filled` and `status` are deliberately NOT produced here: the sheet does not
     track them, and a refresh must never wipe what somebody filled in. The
     caller merges these over the existing record and keeps those two. */
  function toRequisitionRecords(parsed) {
    return (parsed.rows || []).map(function (r) {
      return {
        id: 'REQ-' + r.reqNumber,
        title: r.jobType || r.jobFunction || 'Open order',
        department: r.account || '',
        building: r.building || '',
        shift: r.shift || '',
        openings: r.openings,
        due: r.hireDate || '',
        reportTo: r.reportTo || '',
        notes: [r.jobFunction, r.notes].filter(Boolean).join(' · ').slice(0, 400),
        source: 'PLX workbook'
      };
    });
  }

  /* ---------- the schedule the workbook already implies ----------
     The Key says what hours each shift runs and on which days; the HC tabs say
     which shift each associate is on. Between them the workbook already states
     who is expected when, so coverage does not need a separate weekly export.

     What this CANNOT know is a specific day off: the WFM weekly export marks PTO
     and holidays per date, and a standing schedule has no such thing. Approved
     time off in this suite is what covers that instead. */
  var WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
  function dayNumber(word) {
    var w = String(word || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 5);
    for (var k in WEEKDAYS) {
      if (w.indexOf(k) === 0) return WEEKDAYS[k];
    }
    return -1;
  }
  // "Mon-Fri" -> [1,2,3,4,5]; "Wed" -> [3]; a range that wraps the weekend works.
  function parseDayRange(days) {
    var s = String(days || '').trim();
    if (!s) return [];
    var parts = s.split(/\s*(?:-|through|to)\s*/i);
    var a = dayNumber(parts[0]);
    if (a === -1) return [];
    if (parts.length < 2) return [a];
    var b = dayNumber(parts[1]);
    if (b === -1) return [a];
    var out = [], d = a;
    for (var guard = 0; guard < 7; guard++) {
      out.push(d);
      if (d === b) break;
      d = (d + 1) % 7;
    }
    return out;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function isoOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  /* A schedule in the shape buildCoverage() expects, derived from the shift tags
     rather than uploaded. Covers the week containing `asOf`, which is all any
     single coverage check looks at.

     Anyone whose hours the Key does not pin down gets NO shifts rather than
     guessed ones -- they are counted in `withoutHours` so the gap is visible
     instead of quietly reading as "not scheduled". */
  function scheduleFromShifts(records, opts) {
    opts = opts || {};
    // ScheduleCore.nameKey when the caller supplies it; the same rules inline
    // otherwise, so this module stays usable on its own.
    var keyOf = opts.nameKeyOf || function (v) {
      var t = String(v == null ? '' : v).toLowerCase();
      var parts = t.split(',');
      var clean = function (x) { return x.replace(/[^a-z]/g, ''); };
      return parts.length >= 2 ? clean(parts[0]) + ',' + clean(parts.slice(1).join(' ')) : clean(t);
    };
    var asOf = (opts.asOf && typeof opts.asOf.getTime === 'function') ? opts.asOf : new Date();
    var start = new Date(asOf.getTime());
    start.setDate(start.getDate() - start.getDay() - 1);     // the day before Sunday
    var dates = [];
    for (var i = 0; i < 9; i++) {                            // a week, plus a day either side
      var d = new Date(start.getTime());
      d.setDate(d.getDate() + i);
      dates.push({ iso: isoOf(d), dow: d.getDay() });
    }

    /* Which shifts each building demonstrably runs: the ones somebody there was
       actually given hours for. Taken from the records rather than the Key so
       this still holds on a later page load, when only the stored shift tags are
       to hand and the workbook is long gone. */
    var runs = {};
    (records || []).forEach(function (r) {
      if (!r || !r.hours || !r.building || !r.shift) return;
      if (!runs[r.building]) runs[r.building] = {};
      runs[r.building][r.shift] = true;
    });

    var people = [], withoutHours = [];
    (records || []).forEach(function (r) {
      if (!r || !r.nameKey) return;
      var win = r.hours ? parseKeySchedule(r.hours) : null;
      if (!win || win.start == null) {
        /* Two different things land here. Somebody on a shift their building
           really runs is a genuine gap -- their Key row is missing, or their dept
           code is not one the Key lists -- and needs saying. Somebody on a shift
           that does not exist at their building at all (a "5" typed into a
           building that runs 1st and 2nd) is a data-entry slip, already reported
           by validateAgainstKey; repeating it here nags twice about one problem
           and buries the gaps that can actually be acted on. */
        if (runs[r.building] && runs[r.building][r.shift]) {
          withoutHours.push({ name: r.name, building: r.building, shift: r.shift });
        }
        return;
      }
      var dows = parseDayRange(win.days);
      var shifts = {};
      dates.forEach(function (d) {
        if (dows.length && dows.indexOf(d.dow) === -1) return;
        shifts[d.iso] = {
          raw: win.raw, start: win.start, end: win.end,
          overnight: !!win.overnight, hours: win.hours, suspect: false
        };
      });
      /* buildCoverage joins the schedule to the on-premise report on nameKey()
         -- the "last,first" WFM form -- while a shift record stores rosterKey(),
         the sorted cross-source form used to reach a roster badge. Passing the
         wrong one through here matches nothing at all, so the key is recomputed
         from the name rather than reused. */
      people.push({
        name: r.name,
        nameKey: keyOf(r.name),
        rosterKey: r.nameKey,
        /* The WFM employee id, which the on-premise report also carries. It is
           the only exact way to match these two -- the workbook and WFM
           disagree about compound surnames often enough that the name alone
           loses about one person in six. */
        eid: r.eid || '',
        location: r.building || '',
        job: r.shift || '', shifts: shifts, ambiguous: false
      });
    });

    return {
      periodStart: dates[0].iso,
      periodEnd: dates[dates.length - 1].iso,
      executedAt: '',
      derived: true,                 // so the UI can say where this came from
      dates: dates.map(function (d) { return d.iso; }),
      people: people,
      withoutHours: withoutHours,
      warnings: withoutHours.length
        ? [withoutHours.length + ' associate(s) have a shift the Key does not give one set of hours for, ' +
           'so they cannot be scheduled from the workbook: ' +
           [...new Set(withoutHours.map(function (x) { return x.building + ' ' + x.shift; }))].join(', ') + '.']
        : []
    };
  }

  /* ---------- storage shape ----------
     One record per associate. The id is the EID when there is one, because that
     is stable and matches the on-premise report directly; otherwise it falls
     back to the name key so someone with no EID yet is still tagged. */
  /* An associate's dept code is "<building>-<accountNum>" (e.g. "1502-18845").
     The Key knows which client that account is, so the pair becomes a place a
     person can read: site 1502, account CCM. */
  function accountOf(key, building, dept) {
    var num = String(dept || '').split('-')[1];
    if (!num || !key || !key.accounts) return '';
    return key.accounts[building + '|' + num.trim()] || '';
  }

  /* ---------- hours somebody supplied by hand ----------
     The Key does not state hours for every shift it lists -- a new lane, a
     client whose row was never filled in -- and an associate on a shift with no
     hours cannot be scheduled at all. They fall out of coverage entirely rather
     than reading as absent, which is the quiet kind of missing.

     The fix belongs in the workbook, and this does not pretend otherwise: it is
     stored as `hoursOverride`, beside the Key's own `hours`, so a re-import
     refreshes what the Key says without touching what a person supplied, and
     the two can always be told apart. An override wins where both exist,
     because somebody chose it on purpose. */
  function effectiveHours(rec) {
    if (!rec) return '';
    return String(rec.hoursOverride || rec.hours || '');
  }
  /* 'building|accountNum|shift' -> the hours to use. Built from the stored Key
     records so an import can apply overrides that were set after the last one. */
  function overrideIndex(keyRecords) {
    var out = {};
    (keyRecords || []).forEach(function (r) {
      if (!r || !r.hoursOverride || !r.building || !r.shift) return;
      out[r.building + '|' + (r.accountNum || '') + '|' + r.shift] = String(r.hoursOverride);
      // Also without the account, so a site whose dept codes are blank still
      // picks the override up.
      out[r.building + '||' + r.shift] = String(r.hoursOverride);
    });
    return out;
  }
  function overrideFor(overrides, building, shift, accountNum) {
    if (!overrides) return '';
    return overrides[building + '|' + (accountNum || '') + '|' + shift] ||
      overrides[building + '||' + shift] || '';
  }

  function toShiftRecords(headcount, key, overrides) {
    return headcount.people.map(function (p) {
      var acct = resolveAccount(p.building, accountNumOf(p.dept));
      var w = windowFor(key, p.building, p.shift, acct);
      // A hand-supplied window beats the Key's, and stands in where the Key has
      // nothing -- otherwise this person is unschedulable for another week.
      var manual = overrideFor(overrides, p.building, p.shift, acct);
      return {
        id: p.eid ? 'eid:' + p.eid : 'name:' + p.nameKey,
        eid: p.eid,
        nameKey: p.nameKey,
        name: p.name,
        shift: p.shift,
        building: p.building,
        dept: p.dept,
        // Denormalised so a profile can show the site and hours without the Key.
        account: accountOf(key, p.building, p.building + '-' + acct),
        hours: manual || (w ? w.raw : ''),
        source: 'PLX workbook'
      };
    });
  }

  /* ---------- the Key as records ----------
     The Key is the site's own answer to "which shifts does this building run,
     for which client, on what hours" -- and it was being read at import, used
     to stamp hours onto each person, and then thrown away. Nothing kept it, so
     the moment the page reloaded the only trace of the vocabulary left was
     whatever happened to be denormalised onto an associate. A shift with nobody
     on it today -- a client between orders, a lane about to start -- had no
     trace at all.

     Flattened to one record per row of the Key so it stores like every other
     collection. Rows that say the same thing twice collapse; rows that differ
     only by job title stay apart, because they do. */
  function toKeyRecords(key) {
    if (!key || !key.entries) return [];
    var seen = {}, out = [];
    key.entries.forEach(function (e) {
      var base = ['SK', e.building, e.accountNum || '0', e.shift, e.job || '']
        .join('-').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 58);
      // Truncation can collide where two long job titles share a prefix. The
      // suffix keeps them separate rather than letting one overwrite the other.
      var id = base, n = 1;
      while (seen[id]) { id = base + '~' + (++n); }
      seen[id] = true;
      out.push({
        id: id,
        building: e.building,
        shift: e.shift,
        account: e.account || '',
        accountNum: e.accountNum || '',
        job: e.job || '',
        beelineShift: e.beelineShift || '',
        // The window as the Key writes it. Blank where the Key gave no hours,
        // or gave something this file would only be guessing at.
        hours: e.schedule ? e.schedule.raw : '',
        supervisor: e.supervisor || '',
        source: 'PLX workbook'
      });
    });
    return out;
  }

  /* A shift the building does not run is a typo in the sheet, not a new shift.
     Reported rather than stored silently -- a mistyped tag puts someone in the
     wrong headcount block, where nobody is looking for them. */
  function aliasWarnings(headcount) {
    var used = {};
    (headcount.people || []).forEach(function (p) {
      var k = p.building + '|' + accountNumOf(p.dept);
      if (ACCOUNT_ALIASES[k]) used[k] = (used[k] || 0) + 1;
    });
    return Object.keys(used).map(function (k) {
      var parts = k.split('|');
      return used[k] + ' associate(s) have dept ' + parts[0] + '-' + parts[1] +
        ', which is not in the Key. Read as ' + parts[0] + '-' + ACCOUNT_ALIASES[k] +
        '. Correct it in the workbook and this stops being needed.';
    });
  }

  function validateAgainstKey(headcount, key) {
    var warnings = aliasWarnings(headcount);
    if (!key || !key.byBuilding) return warnings;
    var bad = {};
    headcount.people.forEach(function (p) {
      var known = key.byBuilding[p.building];
      if (!known || !known.length) return;          // building not in the Key at all
      if (known.indexOf(p.shift) !== -1) return;
      var k = p.building + '|' + p.shift;
      (bad[k] = bad[k] || []).push(p.name);
    });
    Object.keys(bad).sort().forEach(function (k) {
      var parts = k.split('|'), who = bad[k];
      warnings.push('Building ' + parts[0] + ' has no shift "' + parts[1] + '" in the Key (it runs ' +
        key.byBuilding[parts[0]].join(', ') + '). ' +
        (who.length === 1 ? who[0] + ' is' : who.length + ' people are') + ' tagged with it.');
    });
    return warnings;
  }

  /* Index the stored records for lookup from either namespace: by EID (which the
     on-premise report carries) and by name key (the only bridge to a roster
     profile). A name that maps to two different shifts is poisoned rather than
     guessed at, the same way the roster name index works. */
  function indexShifts(records) {
    var byEid = new Map(), byName = new Map();
    (records || []).forEach(function (r) {
      if (r.eid) byEid.set(String(r.eid).trim().toUpperCase(), r);
      if (r.nameKey) {
        byName.set(r.nameKey, byName.has(r.nameKey) && byName.get(r.nameKey).shift !== r.shift ? null : r);
      }
    });
    return {
      byEid: byEid,
      byName: byName,
      // eid wins; name is the fallback and is reported as such.
      find: function (eid, nameKey) {
        if (eid) {
          var hit = byEid.get(String(eid).trim().toUpperCase());
          if (hit) return { record: hit, how: 'eid' };
        }
        if (nameKey) {
          var byN = byName.get(nameKey);
          if (byN) return { record: byN, how: 'name' };
        }
        return { record: null, how: '' };
      }
    };
  }

  /* ---------- connecting the workbook roster to profiles ----------
     The workbook states an EID for every associate on it; the roster states a
     badge. Nothing states both, so a profile only ever learns its EID by matching
     on NAME -- and the two systems disagree about surnames often enough that a
     handful of people never join up. One letter is enough: "Wilingham, Ahmad" on
     the workbook against "Willingham, Ahmad" on the roster, and that person is
     invisible to attendance, points and time off.

     A connection made by hand is stored in timeclockLinks and outlives every
     upload, so this is a job done once and then only for new starters. What makes
     it minutes rather than an afternoon is the suggestion: the roster is searched
     for the closest name not already spoken for, and offered for one click.

     Nothing here connects anything on its own. A high score is a reason to look,
     not a decision -- "Meneses Arias, Kevin" and "Arias, Kevin" score well and may
     be two people, and a wrong connection files one person's attendance against
     another.

     similarity(a, b) is injected rather than imported, so this file keeps no
     dependency of its own; the app passes ReconcileCore.nameSimilarity. */
  function connectionReview(opts) {
    opts = opts || {};
    var shifts = opts.shifts || [];
    var profiles = opts.profiles || [];
    var links = opts.links || [];
    var similarity = opts.similarity || function () { return 0; };
    var min = opts.min == null ? 0.6 : opts.min;
    var maxSuggestions = opts.maxSuggestions || 3;

    /* An EID already on a profile is connected, however it got there -- a name
       that happened to match, or somebody's earlier decision.

       A profile holds ONE timeclock id, but a person can genuinely have several:
       the same associate appears under 80- for one agency and 87- for another, and
       a workbook row can carry a mistyped id belonging to somebody else. So the
       stored links are consulted too. Otherwise connecting such a person saved
       correctly and changed nothing on screen -- their profile kept the other id,
       the row stayed unconnected, and it could be connected forever without ever
       clearing. */
    var byBadge = {};
    profiles.forEach(function (p) { if (p && p.badge) byBadge[String(p.badge).trim()] = p; });
    var connectedEids = {};
    profiles.forEach(function (p) {
      if (p && p.timeclockId) connectedEids[String(p.timeclockId).trim().toUpperCase()] = p;
    });
    // A link only counts if it points at somebody actually on the roster.
    var linkedByBadge = {};
    links.forEach(function (l) {
      if (!l || !l.eid || !l.badge) return;
      var p = byBadge[String(l.badge).trim()];
      if (!p) return;
      connectedEids[String(l.eid).trim().toUpperCase()] = p;
      (linkedByBadge[l.badge] = linkedByBadge[l.badge] || []).push(String(l.eid).trim());
    });
    // Only a profile with no EID yet can be offered: one already connected is
    // spoken for, and offering it again invites two people onto one record.
    var available = profiles.filter(function (p) { return p && !p.timeclockId; });

    var out = { total: 0, connected: 0, unconnected: [], noEid: [] };
    var seen = {};
    shifts.forEach(function (r) {
      if (!r) return;
      var eid = String(r.eid || '').trim();
      if (!eid) {
        // A workbook row with no EID cannot be connected by this route at all.
        out.noEid.push({ name: r.name || '', shift: r.shift || '', building: r.building || '' });
        return;
      }
      var key = eid.toUpperCase();
      if (seen[key]) return;
      seen[key] = true;
      out.total++;
      if (connectedEids[key]) { out.connected++; return; }

      var scored = [];
      available.forEach(function (p) {
        var score = similarity(r.name, p.name);
        if (score >= min) scored.push({ badge: p.badge, name: p.name, empNumber: p.empNumber || '', score: score });
      });
      scored.sort(function (a, b) { return b.score - a.score; });
      out.unconnected.push({
        eid: eid,
        name: r.name || '',
        nameKey: r.nameKey || '',
        shift: r.shift || '',
        building: r.building || '',
        dept: r.dept || '',
        suggestions: scored.slice(0, maxSuggestions),
        best: scored.length ? scored[0].score : 0
      });
    });

    // Closest first: what a person can settle at a glance comes first, and what
    // needs real thought sinks below it rather than blocking it.
    out.unconnected.sort(function (a, b) {
      return b.best - a.best || String(a.name).localeCompare(String(b.name));
    });

    /* Two workbook rows whose best suggestion is the same profile. Only one can
       be right, so neither is offered for one click -- that is exactly where a
       hasty click files somebody's attendance against a stranger. */
    // Named apart from byBadge above, which maps a badge to its PROFILE. Reusing
    // that name here quietly replaced the profile lookup for everything below.
    var claimants = {};
    out.unconnected.forEach(function (u) {
      if (!u.suggestions.length) return;
      var b = u.suggestions[0].badge;
      (claimants[b] = claimants[b] || []).push(u);
    });
    Object.keys(claimants).forEach(function (b) {
      if (claimants[b].length < 2) return;
      claimants[b].forEach(function (u) { u.contested = true; });
    });

    /* One person carrying several timeclock ids. Usually legitimate -- the same
       associate under two agencies -- but it is also what a mistyped id in the
       workbook looks like, so it is disclosed rather than assumed either way. */
    out.multiLinked = Object.keys(linkedByBadge)
      .filter(function (b) { return linkedByBadge[b].length > 1; })
      .map(function (b) {
        return { badge: b, name: byBadge[b] ? byBadge[b].name : '', eids: linkedByBadge[b] };
      });

    out.summary = {
      total: out.total,
      connected: out.connected,
      unconnected: out.unconnected.length,
      withSuggestion: out.unconnected.filter(function (u) { return u.suggestions.length && !u.contested; }).length,
      contested: out.unconnected.filter(function (u) { return u.contested; }).length,
      noMatch: out.unconnected.filter(function (u) { return !u.suggestions.length; }).length,
      noEid: out.noEid.length,
      multiLinked: out.multiLinked.length
    };
    return out;
  }

  var api = {
    KEY_SHEET: KEY_SHEET,
    HC_SHEET: HC_SHEET,
    REQ_SHEET: REQ_SHEET,
    parseRequisitions: parseRequisitions,
    toRequisitionRecords: toRequisitionRecords,
    parseLoose: parseLoose,
    parseKeySchedule: parseKeySchedule,
    parseShiftKey: parseShiftKey,
    parseHeadcount: parseHeadcount,
    toKeyRecords: toKeyRecords,
    effectiveHours: effectiveHours,
    overrideIndex: overrideIndex,
    overrideFor: overrideFor,
    windowFor: windowFor,
    accountNumOf: accountNumOf,
    toShiftRecords: toShiftRecords,
    ACCOUNT_ALIASES: ACCOUNT_ALIASES,
    resolveAccount: resolveAccount,
    aliasWarnings: aliasWarnings,
    parseDayRange: parseDayRange,
    scheduleFromShifts: scheduleFromShifts,
    accountOf: accountOf,
    validateAgainstKey: validateAgainstKey,
    indexShifts: indexShifts,
    connectionReview: connectionReview
  };
  root.ShiftKey = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
