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
  /* Both reports are exported per site. Pairing a schedule for one site with an
     on-premise pull for another yields a confident, catastrophic, and completely
     wrong result -- every scheduled person reads as absent because they are
     simply not in the other file. Below this share of scheduled people found on
     premise, say so instead of reporting it as a coverage failure. */
  var LOW_OVERLAP_RATIO = 0.5;
  /* Someone who punched OUT instead of in reads as absent to the badge reader.
     Documenting them with this disposition overrides the reader -- they were
     here. Shared with suite.js so both sides agree on the exact string. */
  var PRESENT_DISPOSITION = 'Present';

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
    /* On the clock with nothing scheduled to cover them. severity stays 'bad' on
       purpose: this is the state that MUST stay in front of a supervisor, and
       'bad' is what keeps it inside the default "Exceptions only" filter. It is
       not an accusation -- the ordinary cause is voluntary overtime, and the
       next most common is a shift that never got entered. Either way somebody
       is on the floor being paid for hours nothing planned for, so it is worth
       a look and never worth hiding. onShift is false because they were not
       expected, so coverage is not measured against them. */
    unscheduled: { label: 'Unscheduled',    severity: 'bad',  onShift: false,
      desc: 'On premise with no shift covering right now -- usually voluntary overtime, sometimes a shift nobody entered.' },
    off:         { label: 'Off',            severity: 'ok',   onShift: false, desc: 'Not scheduled and not on premise.' },
    /* Approved time off covering today. onShift is false deliberately: they are
       scheduled, but their absence is authorised, so counting them in the
       denominator would report the floor as under-covered for a reason that is
       nobody's attendance problem. The count is surfaced separately instead, so
       a supervisor can still see the floor is short. */
    pto:         { label: 'On PTO',         severity: 'ok',   onShift: false, desc: 'Approved time off covering today, so not expected on the floor.' },
    /* Scheduled, but with no row in the on-premise report at all -- not even a
       FALSE one. The report lists everyone active in the timeclock, so somebody
       missing from it has not been set up there yet, which is the ordinary case
       for a new starter. That is a system gap, not an attendance one: they may
       well be on the floor working.

       severity is 'warn', not 'bad'. It needs somebody to act, but the action
       is to add them to the timeclock, not to chase them for a punch -- and it
       must never turn into an attendance point, which is what calling it
       'missing' invited. onShift is false so coverage is not marked down for
       somebody whose presence simply cannot be known. */
    notInReport: { label: 'Not in timeclock', severity: 'warn', onShift: false, desc: 'On the workbook roster and scheduled, but absent from the on-premise report entirely -- no timeclock record yet.' }
  };
  var STATUS_ORDER = ['missing', 'unscheduled', 'notInReport', 'lingering', 'working', 'starting', 'early', 'scheduled', 'complete', 'pto', 'off'];

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

  /* Both WFM reports say "Last, First", but the RC/Beeline roster says
     "First Last". nameKey() deliberately keeps the comma so two WFM reports can
     never silently unify a reversed name -- which means it can NEVER match a
     roster name. rosterKey() is the cross-source key: it reduces either order to
     the same sorted first+last pair, and ignores middle names, which appear in
     one system and not the other.

       "Ava Reed"      -> "ava reed"
       "Reed, Ava"     -> "ava reed"
       "Reed, Ava B"   -> "ava reed"

     Used ONLY for the roster join. WFM-to-WFM matching keeps nameKey(). */
  function rosterKey(v) {
    var s = String(v == null ? '' : v).toLowerCase().replace(/[^a-z\s,]/g, '');
    var first, last;
    if (s.indexOf(',') !== -1) {
      var parts = s.split(',');
      last = (parts[0].trim().split(/\s+/)[0]) || '';
      first = ((parts[1] || '').trim().split(/\s+/)[0]) || '';
    } else {
      var toks = s.trim().split(/\s+/).filter(Boolean);
      first = toks[0] || '';
      last = toks.length > 1 ? toks[toks.length - 1] : '';
    }
    return [first, last].filter(Boolean).sort().join(' ');
  }

  /* ---------- every key a name could reasonably be filed under ----------

     rosterKey() above is not symmetric, and cannot be. From "Alexander Gomez
     Amarales" it takes the FIRST and LAST token; from "Gomez Amarales,
     Alexander" it takes the given name and the FIRST surname token. Those agree
     only when the surname is a single word -- so every compound surname, which
     on this roster is a large share of the floor, produced two different keys
     for one person and joined to nothing.

     There is no single key that fixes it, because "Alexander Gomez Amarales"
     genuinely does not say whether Gomez is a middle name or half the surname.
     So a name gets a SET of candidates instead: the given name paired with each
     surname token in turn. Two spellings of one person overlap on at least one:

       Alexander Gomez Amarales  -> alexander gomez, alexander amarales
       Gomez Amarales, Alexander -> alexander gomez, alexander amarales

     rosterKey()'s own answer is always first in the list, so anything matching
     today keeps matching by exactly the route it takes now, and the widened keys
     only ever add. The keys derive from the stored NAME, never from a stored
     key, so no re-import is needed to pick up the fix.

     Accents fold (Nuñez == Nunez) and hyphens split (Ramirez-Campos ==
     Ramirez Campos), because both spellings turn up across the two systems. */
  var NAME_SUFFIXES = { jr: 1, jnr: 1, sr: 1, snr: 1, ii: 1, iii: 1, iv: 1 };

  function foldAccents(v) {
    var s = String(v == null ? '' : v);
    // "Nuñez" -> "Nunez". Without this the tilde is simply deleted, leaving
    // "nuez", which matches nothing on the other side.
    return s.normalize ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : s;
  }
  function nameTokens(v) {
    return String(v || '').split(/\s+/).filter(Boolean);
  }
  function rosterKeys(v) {
    var out = [], seen = {};
    var add = function (k) { if (k && !seen[k]) { seen[k] = 1; out.push(k); } };
    add(rosterKey(v));                       // what today already matches on

    // Punctuation becomes a separator here, unlike rosterKey which deletes it.
    var s = foldAccents(v).toLowerCase().replace(/[^a-z,]+/g, ' ');
    var given, family;
    if (s.indexOf(',') !== -1) {
      var parts = s.split(',');
      family = nameTokens(parts[0]);
      given = nameTokens(parts.slice(1).join(' '));
    } else {
      var toks = nameTokens(s);
      given = toks.slice(0, 1);
      // Everything after the given name is a possible surname. A middle name
      // among them costs an extra candidate, never a wrong one on its own.
      family = toks.slice(1);
    }
    // "Gordon jr" is Gordon. A suffix is never the name somebody is filed under.
    family = family.filter(function (x) { return x.length > 1 && !NAME_SUFFIXES[x]; });
    var g = given.filter(function (x) { return x.length > 1; })[0] || given[0] || '';
    if (!g) return out;
    family.forEach(function (f) { add([g, f].sort().join(' ')); });
    return out;
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
  /* A Date, whatever realm it came from. `instanceof Date` is realm-bound, so a
     Date built outside this script's window (a test harness, an iframe) fails it
     and we would silently fall back to "now" -- computing coverage for the wrong
     instant and reporting it with full confidence. Duck-type instead. */
  function asDate(v, fallback) {
    return (v && typeof v.getTime === 'function' && !isNaN(v.getTime())) ? v : fallback;
  }
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

  /* How much of the schedule the on-premise report actually accounts for. The
     on-premise export lists everyone active, so a correctly paired report should
     find nearly every scheduled person. */
  function siteList(people) {
    var seen = {};
    (people || []).forEach(function (p) {
      var l = locationLeaf(p.location);
      if (l) seen[l] = true;
    });
    return Object.keys(seen).sort();
  }
  /* How a scheduled person is found in the on-premise report.

     Both reports come out of WFM and both carry the WFM employee id, so where
     each side has one, matching on it is exact. Matching on the name is not:
     the workbook and WFM disagree about compound surnames and name order often
     enough to lose 52 of 289 people at Chicago alone -- "Meneses Arias, Kevin"
     against WFM's "Arias, Kevin", "Fernandez, Naibelys" against "Naibelys,
     Fernandez". Those are not typos to be normalised away; they are two systems
     that genuinely disagree about which word is the surname.

     The name is still the fallback, because an uploaded WFM schedule export
     identifies people by badge and carries no employee id at all. */
  function presenceIndex(presence) {
    var byEid = new Map(), byName = new Map();
    (presence.people || []).forEach(function (p) {
      if (p.wfmId) byEid.set(String(p.wfmId).toUpperCase(), p);
      if (p.nameKey && !byName.has(p.nameKey)) byName.set(p.nameKey, p);
    });
    return {
      byEid: byEid,
      byName: byName,
      find: function (person) {
        if (!person) return null;
        var eid = person.eid || person.wfmId;
        if (eid) {
          var hit = byEid.get(String(eid).toUpperCase());
          if (hit) return hit;
        }
        return person.nameKey ? byName.get(person.nameKey) || null : null;
      }
    };
  }

  function overlapOf(schedule, presence, index) {
    var matched = 0;
    schedule.people.forEach(function (p) { if (index.find(p)) matched++; });
    return {
      scheduled: schedule.people.length,
      onPremise: presence.people.length,
      matched: matched,
      ratio: schedule.people.length ? matched / schedule.people.length : 1,
      scheduleSites: siteList(schedule.people),
      presenceSites: siteList(presence.people)
    };
  }
  function sitesPhrase(list) { return list.length ? list.join(', ') : 'an unnamed site'; }

  /* opts: { schedule, presence, asOf (Date), graceMinutes } */
  function buildCoverage(opts) {
    opts = opts || {};
    var schedule = opts.schedule || { people: [], dates: [] };
    var presence = opts.presence || { people: [] };
    var asOf = asDate(opts.asOf, new Date());
    var grace = opts.graceMinutes == null ? GRACE_MINUTES : Number(opts.graceMinutes);

    var todayKey = isoDate(asOf);
    var prevKey = isoDate(shiftDays(asOf, -1));
    var nowMin = asOf.getHours() * 60 + asOf.getMinutes();

    var index = presenceIndex(presence);

    var rows = [];
    // Held by identity rather than by key: a person matched on their employee id
    // may carry a different name than the on-premise report has for them, so a
    // name would not reliably strike them off.
    var usedPresence = new Set();

    schedule.people.forEach(function (person) {
      var seenPresence = index.find(person);
      if (seenPresence) usedPresence.add(seenPresence);
      rows.push(evaluate(person, seenPresence, todayKey, prevKey, nowMin, grace));
    });

    // On premise (or expected on premise) but with no row in the weekly schedule.
    presence.people.forEach(function (p) {
      if (usedPresence.has(p)) return;
      rows.push(evaluate(null, p, todayKey, prevKey, nowMin, grace));
    });

    rows.sort(function (a, b) {
      var d = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });

    var overlap = overlapOf(schedule, presence, index);
    var bothLoaded = overlap.scheduled > 0 && overlap.onPremise > 0;
    var mismatch = bothLoaded && overlap.matched === 0;
    var warnings = (schedule.warnings || []).concat(presence.warnings || []);
    if (mismatch) {
      warnings.unshift('None of the ' + overlap.scheduled + ' scheduled people appear in the on-premise ' +
        'report, so no coverage can be calculated. The schedule covers ' + sitesPhrase(overlap.scheduleSites) +
        ' and the on-premise report covers ' + sitesPhrase(overlap.presenceSites) +
        '. These are different sites -- load the schedule exported for the same site.');
    } else if (bothLoaded && overlap.ratio < LOW_OVERLAP_RATIO) {
      warnings.unshift('Only ' + overlap.matched + ' of ' + overlap.scheduled + ' scheduled people appear in ' +
        'the on-premise report. The schedule covers ' + sitesPhrase(overlap.scheduleSites) +
        ' and the on-premise report covers ' + sitesPhrase(overlap.presenceSites) +
        '. Anyone absent from the on-premise report is counted as not clocked in, so coverage may read low.');
    }

    var summary = summarize(rows);
    // A percentage nobody can substantiate is worse than no percentage.
    if (mismatch) summary.coverage = null;

    return {
      asOf: asOf,
      date: todayKey,
      graceMinutes: grace,
      rows: rows,
      summary: summary,
      overlap: overlap,
      mismatch: mismatch,
      warnings: warnings
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
    /* Nobody said they were absent -- the report does not mention them at all.
       Distinguished before anything else, because every branch below assumes
       the timeclock had something to say about this person. */
    if (person && !seen && covering.length) {
      status = 'notInReport';
    } else if (active) {
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
      // The original start, not the -1440 shifted one, so a shift label is
      // derived from when the shift actually begins.
      shiftStart: shift ? shift.shift.start : (todayShift ? todayShift.start : null),
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
    /* On the floor, but not because anything said they should be. Counted
       separately from coverage -- they are not part of the denominator -- and
       surfaced on its own so the number is never lost behind another tile. */
    s.onClockUnscheduled = rows.filter(function (r) {
      return r.present && r.status === 'unscheduled';
    }).length;
    return s;
  }

  /* ---------- roster link ----------
     Reaches from a coverage row to a suite profile. The WFM id is tried whole and
     with its site prefix stripped, then the name. Whichever key hit is recorded on
     the row so a name-only match is never mistaken for an id match when someone is
     acting on it. */
  function rosterNameIndex(profiles) {
    var byName = new Map();
    profiles.forEach(function (p) {
      var k = rosterKey(p.name);
      if (!k) return;
      // A duplicated name on the roster cannot be resolved by name, so it is
      // poisoned rather than guessed at.
      byName.set(k, byName.has(k) ? null : p);
    });
    return byName;
  }
  // Shared by linkRoster() and the schedule writer, so both resolve a person the
  // same way. Returns { profile, how } with how = 'id' | 'name' | ''.
  function resolveProfile(profiles, norm, byName, wfmId, wfmIdSuffix, name) {
    if (wfmId) {
      var byId = profiles.get(norm(wfmId));
      if (byId) return { profile: byId, how: 'id' };
    }
    if (wfmIdSuffix && wfmIdSuffix !== wfmId) {
      var bySuffix = profiles.get(norm(wfmIdSuffix));
      if (bySuffix) return { profile: bySuffix, how: 'id' };
    }
    var byN = byName.get(rosterKey(name));
    if (byN) return { profile: byN, how: 'name' };
    return { profile: null, how: '' };
  }
  /* `links` maps a timeclock id to a badge, from somebody having connected the
     two by hand. It is tried FIRST and beats every automatic rule: a person
     looked at both records and decided, which is worth more than a name that
     happens to line up. It is also the only way to fix a name the reports spell
     differently, since no amount of matching will join those.

     Rows that reach no profile keep an empty badge and are counted by
     unlinkedRows() -- silently dropping them is what let a handful of people
     disappear from coverage without anyone noticing. */
  function linkRoster(rows, profiles, normBadge, links) {
    if (!profiles || !profiles.size) return rows;
    var norm = normBadge || function (v) { return String(v == null ? '' : v).trim(); };
    var byName = rosterNameIndex(profiles);
    var manual = links || new Map();
    rows.forEach(function (row) {
      var byLink = row.wfmId ? manual.get(String(row.wfmId).trim().toUpperCase()) : null;
      if (byLink && profiles.get(norm(byLink))) {
        var p = profiles.get(norm(byLink));
        row.badge = p.badge;
        row.market = p.market || '';
        row.rosterName = p.name || '';
        row.rosterMatch = 'linked';
        return;
      }
      var hit = resolveProfile(profiles, norm, byName, row.wfmId, row.wfmIdSuffix, row.name);
      if (!hit.profile) return;
      row.badge = hit.profile.badge;
      row.market = hit.profile.market || '';
      row.rosterName = hit.profile.name || '';
      row.rosterMatch = hit.how;
    });
    return rows;
  }

  /* Everyone on the on-premise report who reached no profile AND is on the
     clock. These are the rows a person has to connect by hand; until they do,
     that associate is invisible to attendance, points and every profile view.

     Only people actually present are offered. Someone unconnected and not on the
     clock has nothing to attribute yet, and most of them are GEODIS's own staff,
     who will never have an agency profile to connect to -- listing them buries
     the ones worth acting on. They are counted rather than dropped (see
     unlinkedAbsent), so the pile cannot grow invisibly; the moment one clocks in
     they appear here. */
  /* ---------- approved time off ----------
     Runs after the roster join, because time off is keyed by badge and a row
     only has one once it has reached a profile.

     A person with approved PTO covering the day is not missing, they are off:
     the row is restated as `pto`, which is severity ok, so no documentation box
     appears and no occurrence is ever offered for it. Somebody who turned up
     anyway is left exactly as they are -- being on the clock is a fact, and PTO
     does not un-happen it. That is a real case (a cancelled day, a change of
     mind) and quietly relabelling it would hide hours actually worked. */
  function applyTimeOff(result, index, iso, lookup) {
    if (!result || !result.rows || !index) return result;
    var find = lookup || function (badge, day) { return null; };
    var covered = 0;
    result.rows.forEach(function (r) {
      if (!r.badge) return;
      var req = find(index, r.badge, iso);
      if (!req) return;
      // Recorded on every matching row, present or not, so the contradiction of
      // being on the clock during approved time off can be shown rather than
      // smoothed over.
      r.ptoRequest = { id: req.id, type: req.type || 'PTO', start: req.start || '', end: req.end || '' };
      if (r.present) return;
      // Nothing to restate for somebody who was not expected today anyway.
      if (r.status === 'off') return;
      r.wasStatus = r.status;
      r.status = 'pto';
      // Every field derived from the status has to move with it. The label is
      // what the table prints, and leaving it behind is how a row ends up
      // reading "Not clocked in" while counting as PTO everywhere else.
      r.statusLabel = STATUS[r.status].label;
      r.severity = STATUS[r.status].severity;
      r.onShift = STATUS[r.status].onShift;
      covered++;
    });
    if (covered) recount(result);
    result.summary.onPto = result.rows.filter(function (r) { return r.status === 'pto'; }).length;
    return result;
  }

  /* The summary is derived from the rows, so restating a row means running the
     same derivation again rather than adjusting counters by hand. Adjusting by
     hand is how a summary ends up disagreeing with the table under it. */
  function recount(result) {
    var s = summarize(result.rows);
    // A site mismatch already ruled coverage unknowable; do not resurrect it.
    if (result.mismatch) s.coverage = null;
    result.summary = s;
    return result;
  }

  function unlinkedRows(rows) {
    return (rows || []).filter(function (r) { return !r.badge && r.inPresence && r.present; });
  }
  // Unconnected and on the report, but not on the clock: disclosed as a count so
  // nothing vanishes silently.
  function unlinkedAbsent(rows) {
    return (rows || []).filter(function (r) { return !r.badge && r.inPresence && !r.present; });
  }
  // A timeclock id -> badge map from the stored links collection.
  function linkIndex(records) {
    var m = new Map();
    (records || []).forEach(function (r) {
      if (r && r.eid && r.badge) m.set(String(r.eid).trim().toUpperCase(), String(r.badge));
    });
    return m;
  }

  /* ---------- persistence shapes ----------
     What actually gets written to Firebase. Kept here, next to the logic that
     produces it, so the storage shape and the matching rules cannot drift.

     A person is identified by the best key available, in this order: roster badge,
     WFM id, then name. The prefix keeps the three namespaces from colliding, and
     it records WHICH kind of key it is -- so a name-derived key is never later
     mistaken for a badge. */
  function personKey(row) {
    if (row.badge) return 'b:' + row.badge;
    if (row.wfmId) return 'w:' + row.wfmId;
    return 'n:' + rosterKey(row.name);
  }
  // The keys a roster profile could have been stored under. A profile has no WFM
  // id of its own, so badge and name are the two ways back to its history.
  function profileKeys(profile) {
    var out = [];
    if (profile.badge) out.push('b:' + profile.badge);
    var k = rosterKey(profile.name);
    if (k) out.push('n:' + k);
    return out;
  }
  // Local, not UTC -- an as-of instant belongs to the site's calendar day.
  function isoDateTime(d) {
    return isoDate(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* One stored on-premise check. Everyone who was NOT where they should be is
     kept in full; everyone who was on premise is kept as a bare key. That is
     enough to prove presence later without writing a row per person per pull.

     The id is derived from the as-of instant, so re-uploading the same export
     replaces that check instead of double-counting the day. */
  /* One row, projected for storage. Shared by `rows` and `exceptions` so the two
     can never drift into different shapes -- they are the same rows, held for
     different lengths of time. */
  function checkRow(r) {
    return {
      key: personKey(r), name: r.name, badge: r.badge || '', wfmId: r.wfmId || '',
      status: r.status, present: !!r.present,
      shift: r.shiftRaw || r.dayCode || '', location: r.location || '',
      job: r.job || '', manager: r.manager || ''
    };
  }

  function toCheck(res, opts) {
    opts = opts || {};
    var exceptions = res.rows.filter(function (r) {
      var sev = STATUS[r.status].severity;
      return sev === 'bad' || sev === 'warn';
    });
    return {
      id: opts.id || ('CK' + (asDate(res.asOf) ? res.asOf.getTime() : Date.now())),
      asOf: asDate(res.asOf) ? isoDateTime(res.asOf) : '',
      fileName: opts.fileName || '',
      graceMinutes: res.graceMinutes,
      summary: res.summary,
      /* EVERY row, not only the ones that needed acting on. Kept for a week and
         then dropped -- see COVERAGE_ROWS_DIR in functions/index.js -- because a
         full report is what answers "who was actually on the floor at 10am last
         Tuesday", and no amount of exception detail reconstructs it.

         `exceptions` below is deliberately NOT derived from this at read time.
         It outlives it: once the week is up the rows go and the exceptions stay,
         because they are the half somebody may still have to answer for. The
         duplication is the price of the two of them having different lifetimes. */
      rows: res.rows.map(checkRow),
      exceptions: exceptions.map(checkRow),
      presentKeys: res.rows.filter(function (r) { return r.present; }).map(personKey)
    };
  }

  /* The weekly schedule, flattened for storage with a roster badge resolved onto
     each person where possible. The schedule export carries no employee id, so
     the on-premise report is passed in as the bridge: it is what turns a
     scheduled name into a WFM id, and the WFM id is what reaches a badge. */
  function scheduleForStorage(parsed, opts) {
    opts = opts || {};
    var profiles = opts.profiles, presence = opts.presence;
    var norm = opts.normBadge || function (v) { return String(v == null ? '' : v).trim(); };
    var byName = profiles && profiles.size ? rosterNameIndex(profiles) : new Map();
    var presenceByName = new Map();
    if (presence && presence.people) {
      presence.people.forEach(function (p) { presenceByName.set(p.nameKey, p); });
    }
    return {
      periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd,
      executedAt: parsed.executedAt,
      fileName: opts.fileName || '',
      people: parsed.people.map(function (p) {
        var seen = presenceByName.get(p.nameKey);
        var hit = profiles && profiles.size
          ? resolveProfile(profiles, norm, byName, seen ? seen.wfmId : '', seen ? seen.wfmIdSuffix : '', p.name)
          : { profile: null };
        return {
          name: p.name, nameKey: p.nameKey,
          badge: hit.profile ? hit.profile.badge : '',
          wfmId: seen ? seen.wfmId : '',
          location: p.location, job: p.job, shifts: p.shifts
        };
      })
    };
  }

  /* ---------- export for the GEODIS headcount spreadsheet ----------
     Each branch sheet ("1502 - HC", "1559 - Post HC") holds side-by-side shift
     blocks. The columns to the LEFT of the name vary by site -- Transition,
     Status, Dept, Profit Center, or nothing -- but in every sheet these six are
     contiguous and in this order:

       Employee  Name | EID | Start Date | Shift | Current Points | Comments

     So exporting exactly those six, to be pasted at the "Employee  Name" cell of
     the target block, aligns on every branch sheet without having to model each
     site's leading columns. */
  var SHEET_COLUMNS = ['Employee  Name', 'EID', 'Start Date', 'Shift', 'Current Points', 'Comments'];

  /* Shift label from the scheduled start. Matches the "Geodis Key" mapping:
     1st = 6:00/7:00 AM starts, 2nd = 3:00 PM starts, 3rd = overnight. Sites that
     label their shifts A/B/C will need those renamed by hand -- the grouping is
     still right, only the label differs. */
  function shiftLabel(startMin) {
    if (startMin == null) return '';
    var m = ((startMin % 1440) + 1440) % 1440;
    if (m < 720) return '1st';
    if (m < 1200) return '2nd';
    return '3rd';
  }
  // "5/28/2026" -> "5/28/26", which is how the sheet writes start dates.
  function shortDate(v) {
    var m = String(v == null ? '' : v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    return m ? m[1] + '/' + m[2] + '/' + m[3].slice(-2) : String(v == null ? '' : v);
  }

  /* The rows a branch's shift block should contain, plus the Expected / Onsite /
     Short trio that sits in that block's header.

     opts: { location, shift, profiles, documented } -- location is the leaf code
     ("1523"), shift is '1st' | '2nd' | '3rd' | 'all'. */
  function spreadsheetExport(res, opts) {
    opts = opts || {};
    var profiles = opts.profiles, documented = opts.documented || {};
    var wantLoc = opts.location && opts.location !== 'all' ? opts.location : '';
    var wantShift = opts.shift && opts.shift !== 'all' ? opts.shift : '';

    var rows = res.rows.filter(function (r) {
      if (wantLoc && locationLeaf(r.location) !== wantLoc) return false;
      // Only people this shift is responsible for. Someone with neither a shift
      // tag nor a scheduled shift is not part of any block's headcount.
      var label = shiftOf(r, profiles).label;
      if (!label) return false;
      return !wantShift || label === wantShift;
    });

    var out = rows.map(function (r) {
      var p = profiles && r.badge ? profiles.get(r.badge) : null;
      var doc = documented[personKey(r)];
      return {
        // A punch-out mistaken for an absence is corrected here too, or the
        // Onsite count would contradict the Comments cell beside it.
        present: r.present || !!(doc && doc.disposition === PRESENT_DISPOSITION),
        name: r.name,
        eid: r.wfmId || '',
        startDate: p ? shortDate(p.crmStart || p.beeStart || '') : '',
        shift: shiftOf(r, profiles).label,
        shiftSource: shiftOf(r, profiles).source,
        points: p ? p.points : '',
        comments: commentFor(r, documented),
        // Carried for the preview, not written to the sheet.
        status: r.status, badge: r.badge || ''
      };
    }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });

    // Expected is everyone the block covers; Onsite is how many of them are here.
    var expected = out.length;
    var onsite = out.filter(function (r) { return r.present; }).length;
    return {
      columns: SHEET_COLUMNS.slice(),
      rows: out,
      summary: { expected: expected, onsite: onsite, short: expected - onsite }
    };
  }
  /* Which block this person belongs in.

     The profile's shift TAG wins over the shift derived from today's scheduled
     hours. The tag is the standing assignment recorded in the PLX workbook and
     uses each site's own vocabulary -- 1st/2nd at most buildings, A/B/C at 1519
     and 1559 -- whereas a derived label is only ever 1st/2nd/3rd and exists only
     for people the WFM schedule happened to cover this week. Preferring the tag
     is what puts everyone else in the right block. */
  function shiftOf(r, profiles) {
    var p = profiles && r.badge ? profiles.get(r.badge) : null;
    if (p && p.shift) return { label: p.shift, source: 'tag' };
    var derived = shiftLabelFor(r);
    return derived ? { label: derived, source: 'schedule' } : { label: '', source: '' };
  }
  // Every shift label present, so a picker offers what the data actually holds
  // rather than a hardcoded 1st/2nd/3rd.
  function shiftLabelsIn(res, profiles) {
    var seen = {};
    res.rows.forEach(function (r) {
      var l = shiftOf(r, profiles).label;
      if (l) seen[l] = true;
    });
    return Object.keys(seen).sort();
  }

  // The shift a row belongs to, from whichever shift is relevant right now.
  function shiftLabelFor(r) {
    if (r.shiftStart != null) return shiftLabel(r.shiftStart);
    return r.shiftRaw ? shiftLabel(startOf(r.shiftRaw)) : '';
  }
  function startOf(raw) {
    var parsed = parseShiftRange(raw);
    return parsed ? parsed.start : null;
  }
  /* The Comments cell. A documented reason wins, because that is what a person
     actually wrote. Otherwise an exception states itself and anyone who is where
     they should be gets a blank cell rather than noise. */
  function commentFor(r, documented) {
    var doc = documented[personKey(r)];
    if (doc && doc.disposition === PRESENT_DISPOSITION) {
      return doc.reason ? PRESENT_DISPOSITION + ' - ' + doc.reason : PRESENT_DISPOSITION;
    }
    if (doc && (doc.reason || doc.disposition)) {
      return doc.disposition && doc.reason ? doc.disposition + ' - ' + doc.reason : (doc.reason || doc.disposition);
    }
    var sev = STATUS[r.status].severity;
    if (sev === 'bad' || sev === 'warn') return STATUS[r.status].label;
    return '';
  }
  function locationLeaf(path) {
    var parts = String(path == null ? '' : path).split('/');
    return parts[parts.length - 1] || '';
  }
  // Tab-separated, which is what a spreadsheet paste expects. No header row --
  // it is pasted into an existing block that already has its headers.
  function toTsv(exported, withHeader) {
    var lines = withHeader ? [exported.columns.join('\t')] : [];
    exported.rows.forEach(function (r) {
      lines.push([r.name, r.eid, r.startDate, r.shift, r.points, r.comments]
        .map(function (c) { return String(c == null ? '' : c).replace(/[\t\r\n]/g, ' '); }).join('\t'));
    });
    return lines.join('\n');
  }

  /* ---------- reading history back ----------
     Given a stored day and the keys a person could be under, what happened. */
  function presenceHistory(day, keys) {
    var set = {};
    (keys || []).forEach(function (k) { set[k] = true; });
    return ((day && day.checks) || []).map(function (c) {
      var exception = (c.exceptions || []).filter(function (e) { return set[e.key]; })[0] || null;
      return {
        asOf: c.asOf,
        present: (c.presentKeys || []).some(function (k) { return set[k]; }),
        status: exception ? exception.status : '',
        statusLabel: exception ? STATUS[exception.status].label : '',
        severity: exception ? STATUS[exception.status].severity : '',
        shift: exception ? exception.shift : ''
      };
    });
  }
  /* ---------- one attendance state per person per day ----------
     The on-premise report gets pulled several times a day, and each pull is
     stored. That must not turn into several attendance states for one person.

     Presence wins: absent at 10:00 and on premise at 10:30 means they were here.
     A check that says nothing about someone -- not on premise AND not an
     exception, i.e. they were off shift -- is not evidence either way and is
     skipped, so an evening pull cannot mark a 1st-shift associate absent.
     A "Present" disposition overrides the reader entirely. */
  function resolveAttendance(day, keys) {
    var set = {};
    (keys || []).forEach(function (k) { set[k] = true; });

    var evidence = [];
    ((day && day.checks) || []).forEach(function (c) {
      var onPrem = (c.presentKeys || []).some(function (k) { return set[k]; });
      var ex = (c.exceptions || []).filter(function (e) { return set[e.key]; })[0] || null;
      if (!onPrem && !ex) return;                 // this check knows nothing about them
      evidence.push({
        asOf: c.asOf, present: onPrem,
        status: ex ? ex.status : '', shift: ex ? ex.shift : ''
      });
    });

    var doc = documentedFor(day, keys);
    var overridden = !!(doc && doc.disposition === PRESENT_DISPOSITION);
    var seenOnPremise = evidence.some(function (e) { return e.present; });
    var present = overridden || seenOnPremise;
    var firstPresent = (evidence.filter(function (e) { return e.present; })[0] || {}).asOf || '';
    var absences = evidence.filter(function (e) { return !e.present && e.status; });
    var lastAbsence = absences.length ? absences[absences.length - 1] : null;

    var status = '', label = '', severity = '';
    if (present) {
      status = 'present';
      severity = 'ok';
      label = seenOnPremise ? 'On premise' : 'Present (documented)';
    } else if (lastAbsence) {
      status = lastAbsence.status;
      label = STATUS[status] ? STATUS[status].label : status;
      severity = STATUS[status] ? STATUS[status].severity : '';
    }

    return {
      checks: evidence.length,        // how many pulls actually covered them
      evidence: evidence,             // the timeline, for detail
      present: present,
      overridden: overridden,         // present only because someone said so
      status: status, label: label, severity: severity,
      firstPresent: firstPresent,
      shift: (evidence.filter(function (e) { return e.shift; })[0] || {}).shift || '',
      documented: doc
    };
  }

  function documentedFor(day, keys) {
    var docs = (day && day.documented) || {};
    for (var i = 0; i < (keys || []).length; i++) {
      if (docs[keys[i]]) return docs[keys[i]];
    }
    return null;
  }
  // A person's scheduled shifts for the week, from a stored schedule document.
  function scheduleFor(week, keys) {
    var set = {};
    (keys || []).forEach(function (k) { set[k] = true; });
    var people = (week && week.people) || [];
    for (var i = 0; i < people.length; i++) {
      var p = people[i];
      if (set['b:' + p.badge] || set['n:' + rosterKey(p.name)]) return p;
    }
    return null;
  }

  var api = {
    GRACE_MINUTES: GRACE_MINUTES,
    LONG_SHIFT_HOURS: LONG_SHIFT_HOURS,
    STATUS: STATUS,
    STATUS_ORDER: STATUS_ORDER,
    nameKey: nameKey,
    rosterKey: rosterKey,
    rosterKeys: rosterKeys,
    splitNameAndId: splitNameAndId,
    idSuffix: idSuffix,
    isoDate: isoDate,
    asDate: asDate,
    isoFromMdY: isoFromMdY,
    parseClock: parseClock,
    parseShiftRange: parseShiftRange,
    asOfFromFileName: asOfFromFileName,
    parseSchedule: parseSchedule,
    parseOnPremise: parseOnPremise,
    shiftsCovering: shiftsCovering,
    buildCoverage: buildCoverage,
    presenceIndex: presenceIndex,
    LOW_OVERLAP_RATIO: LOW_OVERLAP_RATIO,
    overlapOf: overlapOf,
    siteList: siteList,
    linkRoster: linkRoster,
    applyTimeOff: applyTimeOff,
    unlinkedRows: unlinkedRows,
    unlinkedAbsent: unlinkedAbsent,
    linkIndex: linkIndex,
    personKey: personKey,
    profileKeys: profileKeys,
    isoDateTime: isoDateTime,
    toCheck: toCheck,
    checkRow: checkRow,
    // Stated once, so the page and the server cannot disagree about the window.
    ROW_RETENTION_DAYS: 7,
    scheduleForStorage: scheduleForStorage,
    SHEET_COLUMNS: SHEET_COLUMNS,
    shiftLabel: shiftLabel,
    shiftOf: shiftOf,
    shiftLabelFor: shiftLabelFor,
    shiftLabelsIn: shiftLabelsIn,
    shortDate: shortDate,
    locationLeaf: locationLeaf,
    spreadsheetExport: spreadsheetExport,
    toTsv: toTsv,
    PRESENT_DISPOSITION: PRESENT_DISPOSITION,
    resolveAttendance: resolveAttendance,
    presenceHistory: presenceHistory,
    documentedFor: documentedFor,
    scheduleFor: scheduleFor
  };
  root.ScheduleCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
