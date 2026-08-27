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
    var out = { entries: [], byBuilding: {}, windows: {}, accounts: {}, warnings: [] };
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
    });

    Object.keys(out.byBuilding).forEach(function (b) { out.byBuilding[b].sort(); });
    Object.keys(out.windows).forEach(function (k) {
      if (out.windows[k].length > 1) {
        out.warnings.push('Building ' + k.split('|')[0] + ' shift "' + k.split('|')[1] + '" has ' +
          out.windows[k].length + ' different sets of hours (' +
          out.windows[k].map(function (x) { return x.raw; }).join('; ') +
          '). Its hours depend on the account, so no single window is assumed.');
      }
    });
    return out;
  }

  // The unambiguous window for a building's shift, or null when there is none or
  // more than one.
  function windowFor(key, building, shift) {
    var w = key && key.windows ? key.windows[building + '|' + shift] : null;
    return w && w.length === 1 ? w[0] : null;
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

    var people = [], withoutHours = [];
    (records || []).forEach(function (r) {
      if (!r || !r.nameKey) return;
      var win = r.hours ? parseKeySchedule(r.hours) : null;
      if (!win || win.start == null) {
        withoutHours.push({ name: r.name, building: r.building, shift: r.shift });
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

  function toShiftRecords(headcount, key) {
    return headcount.people.map(function (p) {
      var w = windowFor(key, p.building, p.shift);
      return {
        id: p.eid ? 'eid:' + p.eid : 'name:' + p.nameKey,
        eid: p.eid,
        nameKey: p.nameKey,
        name: p.name,
        shift: p.shift,
        building: p.building,
        dept: p.dept,
        // Denormalised so a profile can show the site and hours without the Key.
        account: accountOf(key, p.building, p.dept),
        hours: w ? w.raw : '',
        source: 'PLX workbook'
      };
    });
  }

  /* A shift the building does not run is a typo in the sheet, not a new shift.
     Reported rather than stored silently -- a mistyped tag puts someone in the
     wrong headcount block, where nobody is looking for them. */
  function validateAgainstKey(headcount, key) {
    var warnings = [];
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
    windowFor: windowFor,
    toShiftRecords: toShiftRecords,
    parseDayRange: parseDayRange,
    scheduleFromShifts: scheduleFromShifts,
    accountOf: accountOf,
    validateAgainstKey: validateAgainstKey,
    indexShifts: indexShifts
  };
  root.ShiftKey = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
