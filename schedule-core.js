/* GEODIS Management Suite -- schedule vs. on-premise coverage.
 *
 * Two WFM reports answer one question: is the person who is supposed to be here
 * actually here right now?
 *
 *   employee_schedule_weekly (.xlsx)  the plan   -- who works which hours, all week
 *   On Premise - Simple      (.csv)   the fact   -- who the badge readers see, right now
 *
 * The schedule report carries NO employee id, only "Last, First". The on-premise
 * report carries "Last, First (80-XXXXX)". So on-premise is the bridge: it is what
 * gives a scheduled name its WFM id, and the WFM id is what reaches the roster.
 *
 *   schedule (name) --> on premise (name + WFM id) --> roster profile (badge)
 *
 * Name is therefore a real join key here, not a fallback. That is safe because both
 * files are produced by the same WFM instance and format names identically -- but it
 * is only safe WITHIN a site, so the location path travels with every row and a
 * name collision across two locations is reported rather than merged.
 *
 * All logic lives in this file, with no DOM access, so the browser tool and a future
 * scheduled Cloud Function can never drift apart -- the same arrangement
 * reconcile-core.js already has with the Beeline/RC crosscheck.
 */
(function (root) {
  'use strict';

  /* ---------- tunables ----------
     A badge-reader snapshot is not instantaneous and neither is a person walking
     from the lot to a clock. GRACE_MINUTES is how long after shift start someone
     may be un-clocked before it is called an exception rather than "starting".
     LONG_SHIFT_HOURS is the point past which a parsed shift is more likely a typo
     in the source report than a real shift -- see parseShiftRange. */
  var GRACE_MINUTES = 10;
  var LONG_SHIFT_HOURS = 16;

  /* ---------- status vocabulary ----------
     severity drives the UI: 'bad' is an exception a supervisor should act on now,
     'warn' is worth a look, 'ok'/'info' are the expected states. */
  var STATUS = {
    working:     { label: 'Working',        severity: 'ok',   onShift: true,  desc: 'On shift and on premise.' },
    missing:     { label: 'Not clocked in', severity: 'bad',  onShift: true,  desc: 'On shift but not on premise.' },
    starting:    { label: 'Starting',       severity: 'info', onShift: true,  desc: 'Shift just started; still inside the grace window.' },
    early:       { label: 'Early',          severity: 'info', onShift: false, desc: 'On premise before the shift starts.' },
    scheduled:   { label: 'Scheduled',      severity: 'info', onShift: false, desc: 'Scheduled later today.' },
    complete:    { label: 'Shift complete', severity: 'ok',   onShift: false, desc: 'Shift is over and they have left.' },
    lingering:   { label: 'Still on site',  severity: 'warn', onShift: false, desc: 'Shift is over but they are still on premise -- overtime or a missed punch out.' },
    unscheduled: { label: 'Unscheduled',    severity: 'bad',  onShift: false, desc: 'On premise with no shift covering right now.' },
    off:         { label: 'Off',            severity: 'ok',   onShift: false, desc: 'Not scheduled and not on premise.' }
  };
  var STATUS_ORDER = ['missing', 'unscheduled', 'lingering', 'working', 'starting', 'early', 'scheduled', 'complete', 'off'];

  /* ---------- names ----------
     Both reports render a name as "Last, First", but casing is inconsistent
     ("lynch, dominque" in the schedule, "Lynch, Dominque" on premise) and
     apostrophes/hyphens appear in some ("O'Brian, Jason"). The key strips
     everything that is not a letter so those variants collapse, while keeping the
     comma so "Last, First" and "First Last" never silently unify. */
  function nameKey(v) {
    if (v == null) return '';
    var s = String(v).toLowerCase();
    var parts = s.split(',');
    var clean = function (x) { return x.replace(/[^a-z]/g, ''); };
    if (parts.length >= 2) return clean(parts[0]) + ',' + clean(parts.slice(1).join(' '));
    return clean(s);
  }

  // "Ortiz, Brysin (80-BORTIZ9517)" -> { name: 'Ortiz, Brysin', id: '80-BORTIZ9517' }
  function splitNameAndId(v) {
    var s = String(v == null ? '' : v).trim();
    var m = s.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    return m ? { name: m[1].trim(), id: m[2].trim() } : { name: s, id: '' };
  }

  /* The WFM id is namespaced by site: "80-CTHOMA4835", "80-302660". Beeline and RC
     may carry only the bare part, so the suffix is kept alongside the full id and
     both are tried when reaching for a roster badge. */
  function idSuffix(v) {
    var s = String(v == null ? '' : v).trim();
    var m = s.match(/^\d+-(.+)$/);
    return m ? m[1] : s;
  }

  /* ---------- dates and times ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  // Local-calendar ISO date. Never toISOString(): that shifts the day in any
  // timezone west of UTC, which is every GEODIS US site.
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function shiftDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }

  // "8/25/2026" -> "2026-08-25". Returns '' for anything else.
  function isoFromMdY(v) {
    var m = String(v == null ? '' : v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? m[3] + '-' + pad(m[1]) + '-' + pad(m[2]) : '';
  }
  function looksLikeMdY(v) { return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(String(v == null ? '' : v).trim()); }

  // "7:30 AM" -> 450 (minutes past local midnight). null if unparseable.
  function parseClock(v) {
    var m = String(v == null ? '' : v).trim().match(/^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?$/i);
    if (!m) return null;
    var h = Number(m[1]) % 12;
    if (/p/i.test(m[3])) h += 12;
    var min = Number(m[2]);
    if (min > 59) return null;
    return h * 60 + min;
  }

  /* "7:30 AM - 4:00 PM"   -> 450..960
     "9:30 PM - 6:00 AM"   -> 1290..1800  (overnight: end rolls into the next day)
     "3:30 PM - 12:00 AM"  -> 930..1440   (midnight is the END of this day, not the start)

     An end at or before the start means the shift crosses midnight -- there is no
     other reading of it. That does mean a mistyped end time inflates the shift
     instead of erroring, so anything past LONG_SHIFT_HOURS is marked suspect and
     surfaced, because a 20-hour shift silently swallowed is a person who looks
     covered all day when nobody is there. */
  function parseShiftRange(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return null;
    var parts = s.split(/\s+-\s+|\s+to\s+/i);
    if (parts.length !== 2) return null;
    var start = parseClock(parts[0]), end = parseClock(parts[1]);
    if (start == null || end == null) return null;
    var overnight = end <= start;
    if (overnight) end += 1440;
    var hours = (end - start) / 60;
    return { raw: s, start: start, end: end, overnight: overnight, hours: hours, suspect: hours > LONG_SHIFT_HOURS };
  }

  // The WFM export names carry the run time: ..._2026-08-25T11_12_00.521.csv
  // That is the report's local execution time, and it is the only "as of" the
  // on-premise file has -- the rows themselves are undated.
  function asOfFromFileName(name) {
    var m = String(name == null ? '' : name).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})[_:](\d{2})[_:](\d{2})/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }

  /* ---------- schedule report ----------
     Layout: a title block, then one section per location --

       GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523        <- location path, alone on its row
       Employee    Primary Job   Sun  Mon  Tue ...  <- column header
                                 8/23 8/24 8/25...  <- the row that actually dates the columns
       Beckman, Paul  Default          7:00 AM - 3:30 PM ...

     Day columns are merged and land at varying indices, so the date row -- not the
     day-name row and not a fixed offset -- is what maps a column to a date. */
  function parseSchedule(aoa) {
    var out = {
      periodStart: '', periodEnd: '', executedAt: '',
      dates: [], people: [], warnings: []
    };
    var seen = new Map();          // nameKey -> person, for cross-location collisions
    // A mistyped shift usually repeats across the whole week. Collect the days and
    // report the shift once, so one bad cell cannot bury the other warnings.
    var suspects = new Map();      // "name|raw" -> { name, raw, hours, dates: [] }
    var dateCols = null;           // column index -> ISO date, for the current section
    var loc = '', jobCol = -1;
    var dateSet = new Set();

    (aoa || []).forEach(function (row, rowIndex) {
      var cells = (row || []).map(function (c) { return c == null ? '' : String(c).trim(); });
      var first = cells[0] || '';
      var filled = cells.filter(function (c) { return c !== ''; });

      // Title block: "Time Period : | | 8/23/2026 - 8/29/2026"
      if (/^time period\s*:/i.test(first)) {
        var span = filled.find(function (c) { return /\d{1,2}\/\d{1,2}\/\d{4}\s*-\s*\d{1,2}\/\d{1,2}\/\d{4}/.test(c); });
        if (span) {
          var ends = span.split(/\s*-\s*/);
          out.periodStart = isoFromMdY(ends[0]);
          out.periodEnd = isoFromMdY(ends[1]);
        }
      }
      var execAt = cells.findIndex(function (c) { return /^executed on\s*:/i.test(c); });
      if (execAt !== -1) {
        var after = cells.slice(execAt + 1).find(function (c) { return c !== ''; });
        if (after) out.executedAt = after;
      }

      // A location path sits alone on its row and is the only thing on it.
      if (filled.length === 1 && first && first.indexOf('/') !== -1 && !looksLikeMdY(first)) {
        loc = first;
        dateCols = null;
        jobCol = -1;
        return;
      }

      // Column header row -- only useful for finding the job column.
      if (/^employee$/i.test(first)) {
        jobCol = cells.findIndex(function (c) { return /primary job/i.test(c); });
        dateCols = null;
        return;
      }

      // The date row: no employee name, but m/d/yyyy values across the day columns.
      if (!first && cells.some(looksLikeMdY)) {
        dateCols = {};
        cells.forEach(function (c, i) {
          if (!looksLikeMdY(c)) return;
          var iso = isoFromMdY(c);
          dateCols[i] = iso;
          dateSet.add(iso);
        });
        return;
      }

      if (!first || !dateCols) return;   // blank spacer, or a row before any section started

      var shifts = {};
      Object.keys(dateCols).forEach(function (i) {
        var raw = cells[i];
        if (!raw) return;
        var parsed = parseShiftRange(raw);
        if (!parsed) {
          // Not a time range -- a day code like "PTO" or "Holiday". Keep it: it
          // explains an absence, so dropping it would turn an approved day off
          // into an unexplained no-show.
          shifts[dateCols[i]] = { raw: raw, start: null, end: null, overnight: false, hours: 0, suspect: false, code: raw };
          return;
        }
        if (parsed.suspect) {
          var sk = first + '|' + raw;
          if (!suspects.has(sk)) suspects.set(sk, { name: first, raw: raw, hours: parsed.hours, dates: [] });
          suspects.get(sk).dates.push(dateCols[i]);
        }
        shifts[dateCols[i]] = parsed;
      });

      var key = nameKey(first);
      if (!key) return;
      var prior = seen.get(key);
      if (prior) {
        // Same name in two locations: merging them would attribute one person's
        // presence to another's shift, so both are kept and the clash is reported.
        out.warnings.push('"' + first + '" appears in more than one location (' +
          prior.location + ' and ' + loc + '). Coverage for that name is not reliable.');
        prior.ambiguous = true;
      }

      var person = {
        name: first,
        nameKey: key,
        location: loc,
        job: jobCol !== -1 ? (cells[jobCol] || '') : '',
        shifts: shifts,
        ambiguous: !!prior,
        row: rowIndex
      };
      if (!prior) seen.set(key, person);
      out.people.push(person);
    });

    suspects.forEach(function (x) {
      var when = x.dates.length === 1 ? 'on ' + x.dates[0]
        : 'on ' + x.dates.length + ' days (' + x.dates[0] + ' to ' + x.dates[x.dates.length - 1] + ')';
      out.warnings.push(x.name + ': "' + x.raw + '" parses as ' + x.hours.toFixed(1) +
        ' hours ' + when + '. Check the source report.');
    });

    out.dates = Array.from(dateSet).sort();
    return out;
  }

  /* ---------- on-premise report ----------
     Employee Full Name & ID | On Premises | Primary location (path) | Reports To
     Columns are matched by header text, not position, so a re-ordered or widened
     export keeps working. */
  var ON_PREM_COLS = {
    person:   [/full name\s*&\s*id/i, /employee full name/i, /^employee$/i, /name/i],
    present:  [/on premis/i, /^present$/i, /on site/i],
    location: [/primary location/i, /location/i],
    manager:  [/reports to/i, /manager/i, /supervisor/i]
  };
  function pickCol(headers, patterns) {
    for (var i = 0; i < patterns.length; i++) {
      var idx = headers.findIndex(function (h) { return patterns[i].test(h); });
      if (idx !== -1) return idx;
    }
    return -1;
  }
  function truthy(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return s === 'true' || s === 'yes' || s === 'y' || s === '1';
  }

  function parseOnPremise(aoa) {
    var out = { people: [], warnings: [], columns: null };
    var rows = aoa || [];
    // Find the header row: the first row that has a recognisable person column.
    var headerRow = -1, cols = null;
    for (var i = 0; i < Math.min(rows.length, 25); i++) {
      var headers = (rows[i] || []).map(function (h) { return h == null ? '' : String(h).trim(); });
      var c = {
        person: pickCol(headers, ON_PREM_COLS.person),
        present: pickCol(headers, ON_PREM_COLS.present),
        location: pickCol(headers, ON_PREM_COLS.location),
        manager: pickCol(headers, ON_PREM_COLS.manager)
      };
      if (c.person !== -1 && c.present !== -1) { headerRow = i; cols = c; break; }
    }
    if (headerRow === -1) {
      out.warnings.push('No "Employee Full Name & ID" and "On Premises" columns were found. Is this the On Premise - Simple export?');
      return out;
    }
    out.columns = cols;

    var seen = new Map();
    rows.slice(headerRow + 1).forEach(function (row) {
      var cells = (row || []).map(function (c) { return c == null ? '' : String(c).trim(); });
      var raw = cells[cols.person];
      if (!raw) return;
      var split = splitNameAndId(raw);
      var key = nameKey(split.name);
      if (!key) return;
      if (seen.has(key)) {
        out.warnings.push('"' + split.name + '" appears more than once in the on-premise report; the first row is used.');
        return;
      }
      var person = {
        name: split.name,
        nameKey: key,
        wfmId: split.id,
        wfmIdSuffix: idSuffix(split.id),
        present: truthy(cells[cols.present]),
        location: cols.location !== -1 ? cells[cols.location] : '',
        manager: cols.manager !== -1 ? cells[cols.manager] : ''
      };
      seen.set(key, person);
      out.people.push(person);
    });
    return out;
  }

  /* ---------- coverage ----------
     For an as-of instant, decide each person's state from the shifts that could
     possibly cover it. That is today's shift AND yesterday's, because a 9:30 PM
     shift is still running at 5 AM the next morning -- evaluating only today would
     report the entire night crew as absent every morning. */
  function shiftsCovering(person, todayKey, prevKey) {
    var out = [];
    var today = person.shifts[todayKey];
    if (today && today.start != null) out.push({ start: today.start, end: today.end, date: todayKey, shift: today });
    var prev = person.shifts[prevKey];
    // Yesterday only matters if it ran past midnight.
    if (prev && prev.start != null && prev.overnight) {
      out.push({ start: prev.start - 1440, end: prev.end - 1440, date: prevKey, shift: prev });
    }
    return out.sort(function (a, b) { return a.start - b.start; });
  }

  /* opts: { schedule, presence, asOf (Date), graceMinutes } */
  function buildCoverage(opts) {
    opts = opts || {};
    var schedule = opts.schedule || { people: [], dates: [] };
    var presence = opts.presence || { people: [] };
    var asOf = opts.asOf instanceof Date ? opts.asOf : new Date();
    var grace = opts.graceMinutes == null ? GRACE_MINUTES : Number(opts.graceMinutes);

    var todayKey = isoDate(asOf);
    var prevKey = isoDate(shiftDays(asOf, -1));
    var nowMin = asOf.getHours() * 60 + asOf.getMinutes();

    var byName = new Map();
    presence.people.forEach(function (p) { byName.set(p.nameKey, p); });

    var rows = [];
    var usedPresence = new Set();

    schedule.people.forEach(function (person) {
      var seenPresence = byName.get(person.nameKey);
      if (seenPresence) usedPresence.add(person.nameKey);
      rows.push(evaluate(person, seenPresence, todayKey, prevKey, nowMin, grace));
    });

    // On premise (or expected on premise) but with no row in the weekly schedule.
    presence.people.forEach(function (p) {
      if (usedPresence.has(p.nameKey)) return;
      rows.push(evaluate(null, p, todayKey, prevKey, nowMin, grace));
    });

    rows.sort(function (a, b) {
      var d = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });

    return {
      asOf: asOf,
      date: todayKey,
      graceMinutes: grace,
      rows: rows,
      summary: summarize(rows),
      warnings: (schedule.warnings || []).concat(presence.warnings || [])
    };
  }

  function evaluate(person, seen, todayKey, prevKey, nowMin, grace) {
    var present = seen ? seen.present : false;
    var covering = person ? shiftsCovering(person, todayKey, prevKey) : [];
    var todayShift = person ? person.shifts[todayKey] : null;

    var active = null, upcoming = null;
    covering.forEach(function (c) {
      if (nowMin >= c.start && nowMin < c.end) { if (!active) active = c; }
      else if (nowMin < c.start && !upcoming) upcoming = c;
    });
    var ended = !active && !upcoming && covering.length > 0;

    var status;
    if (active) {
      if (present) status = 'working';
      else status = nowMin < active.start + grace ? 'starting' : 'missing';
    } else if (upcoming) {
      status = present ? 'early' : 'scheduled';
    } else if (ended) {
      status = present ? 'lingering' : 'complete';
    } else {
      status = present ? 'unscheduled' : 'off';
    }

    var shift = active || upcoming || (covering.length ? covering[covering.length - 1] : null);
    return {
      name: person ? person.name : seen.name,
      nameKey: person ? person.nameKey : seen.nameKey,
      location: (person && person.location) || (seen && seen.location) || '',
      job: person ? person.job : '',
      manager: seen ? seen.manager : '',
      wfmId: seen ? seen.wfmId : '',
      wfmIdSuffix: seen ? seen.wfmIdSuffix : '',
      present: present,
      status: status,
      severity: STATUS[status].severity,
      statusLabel: STATUS[status].label,
      // The scheduled window as text, plus the day code ("PTO") when there is one.
      shiftRaw: shift ? shift.shift.raw : (todayShift ? todayShift.raw : ''),
      shiftDate: shift ? shift.date : '',
      dayCode: todayShift && todayShift.start == null ? todayShift.raw : '',
      overnight: !!(shift && shift.shift.overnight),
      suspectShift: !!(shift && shift.shift.suspect),
      minutesIntoShift: active ? nowMin - active.start : null,
      minutesUntilShift: upcoming ? upcoming.start - nowMin : null,
      ambiguous: !!(person && person.ambiguous),
      inSchedule: !!person,
      inPresence: !!seen,
      // Filled in by linkRoster().
      badge: '', market: '', rosterName: '', rosterMatch: ''
    };
  }

  function summarize(rows) {
    var s = { total: rows.length, onShift: 0, present: 0, exceptions: 0, noSchedule: 0, noPresence: 0, byStatus: {} };
    STATUS_ORDER.forEach(function (k) { s.byStatus[k] = 0; });
    rows.forEach(function (r) {
      s.byStatus[r.status]++;
      if (STATUS[r.status].onShift) s.onShift++;
      if (r.present) s.present++;
      if (r.severity === 'bad') s.exceptions++;
      if (!r.inSchedule) s.noSchedule++;
      if (!r.inPresence) s.noPresence++;
    });
    // Of the people who should be on the floor right now, how many are?
    s.coverage = s.onShift > 0 ? Math.round(s.byStatus.working / s.onShift * 100) : null;
    return s;
  }

  /* ---------- roster link ----------
     Reaches from a coverage row to a suite profile. The WFM id is tried whole and
     with its site prefix stripped, then the name. Whichever key hit is recorded on
     the row so a name-only match is never mistaken for an id match when someone is
     acting on it. */
  function linkRoster(rows, profiles, normBadge) {
    if (!profiles || !profiles.size) return rows;
    var norm = normBadge || function (v) { return String(v == null ? '' : v).trim(); };
    var byName = new Map();
    profiles.forEach(function (p) {
      var k = nameKey(p.name);
      if (!k) return;
      // A duplicated name on the roster cannot be resolved by name, so it is
      // poisoned rather than guessed at.
      byName.set(k, byName.has(k) ? null : p);
    });

    rows.forEach(function (row) {
      var hit = null, how = '';
      if (row.wfmId) {
        hit = profiles.get(norm(row.wfmId));
        if (hit) how = 'id';
      }
      if (!hit && row.wfmIdSuffix && row.wfmIdSuffix !== row.wfmId) {
        hit = profiles.get(norm(row.wfmIdSuffix));
        if (hit) how = 'id';
      }
      if (!hit) {
        var byN = byName.get(row.nameKey);
        if (byN) { hit = byN; how = 'name'; }
      }
      if (!hit) return;
      row.badge = hit.badge;
      row.market = hit.market || '';
      row.rosterName = hit.name || '';
      row.rosterMatch = how;
    });
    return rows;
  }

  var api = {
    GRACE_MINUTES: GRACE_MINUTES,
    LONG_SHIFT_HOURS: LONG_SHIFT_HOURS,
    STATUS: STATUS,
    STATUS_ORDER: STATUS_ORDER,
    nameKey: nameKey,
    splitNameAndId: splitNameAndId,
    idSuffix: idSuffix,
    isoDate: isoDate,
    isoFromMdY: isoFromMdY,
    parseClock: parseClock,
    parseShiftRange: parseShiftRange,
    asOfFromFileName: asOfFromFileName,
    parseSchedule: parseSchedule,
    parseOnPremise: parseOnPremise,
    shiftsCovering: shiftsCovering,
    buildCoverage: buildCoverage,
    linkRoster: linkRoster
  };
  root.ScheduleCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
