/* GEODIS Management Suite -- PTO requests from Microsoft Forms.
 *
 * Two forms feed this, English and Spanish. Power Automate posts each submission
 * as a canonical payload (it does the per-form field mapping, so a third form or
 * a reworded question is a change there, not here) and this turns it into
 * time-off records.
 *
 * Three things the form cannot give us, which is why this exists server-side
 * rather than in the flow:
 *
 *   1. A badge. The form asks for a name, and the roster is badge-keyed, so the
 *      name has to be resolved against the current snapshot -- the same bridge
 *      the coverage view uses. rosterKey() handles "First Last" vs "Last, First".
 *   2. Real dates. "Which date(s)" is free text, so it arrives as anything from
 *      "08/25/26" to "8/25 and 8/26" to "8/25/26 - 8/27/26".
 *   3. One record per stretch of days, rather than one per typed date.
 *
 * Nothing is dropped for failing any of those. A name that does not resolve
 * still produces a request with the name on it, and an unparseable date is
 * reported rather than silently discarded -- a lost PTO request is someone who
 * shows up expecting to be off.
 *
 * No DOM access, no Firebase: pure input -> output, so it can be tested directly.
 */
(function (root) {
  'use strict';

  var FULL_DAY_HOURS = 8;
  var PARTIAL_DAY_HOURS = 4;      // only when the form did not say
  var MAX_RANGE_DAYS = 60;        // a typo must not create a thousand records
  var STALE_DAYS = 180;           // how far back a bare "8/25" may mean this year

  /* ---------- duration ----------
     English: "A full day" / "A partial day".
     Spanish: "Un día completo" / "Un día parcial".
     Matched on the distinguishing word so a reworded option still lands. */
  function durationOf(text) {
    var s = String(text == null ? '' : text).toLowerCase();
    if (!s.trim()) return '';
    if (/parcial|partial|half|medio/.test(s)) return 'partial';
    if (/completo|entero|full|whole|todo/.test(s)) return 'full';
    return '';
  }

  /* ---------- dates ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function isoOf(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
  function daysBetween(aIso, bIso) {
    return Math.round((Date.parse(bIso + 'T00:00:00') - Date.parse(aIso + 'T00:00:00')) / 86400000);
  }
  function addDays(iso, n) {
    var d = new Date(Date.parse(iso + 'T00:00:00'));
    d.setDate(d.getDate() + n);
    return isoOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  function validYmd(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var probe = new Date(y, m - 1, d);
    return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
  }

  /* One typed date. Accepts M/D/YY, M/D/YYYY and a bare M/D.

     A bare "8/25" has no year, so it takes the submission's year -- unless that
     would put it more than STALE_DAYS in the past, in which case it rolls to the
     next year. Someone requesting time off in December for "1/2" means January. */
  function parseOne(token, ref) {
    var s = String(token == null ? '' : token).trim();
    if (!s) return null;
    var m = s.match(/^(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?:\s*[\/\-.]\s*(\d{2,4}))?$/);
    if (!m) return null;
    var mo = Number(m[1]), day = Number(m[2]), yr;
    if (m[3]) {
      yr = Number(m[3]);
      if (yr < 100) yr += 2000;
    } else {
      yr = ref.getFullYear();
      var guess = isoOf(yr, mo, day);
      if (validYmd(yr, mo, day) && daysBetween(guess, isoOf(ref.getFullYear(), ref.getMonth() + 1, ref.getDate())) > STALE_DAYS) {
        yr += 1;
      }
    }
    if (!validYmd(yr, mo, day)) return null;
    return isoOf(yr, mo, day);
  }

  /* The whole free-text answer. Splits on the separators people actually use,
     then expands "a - b" into the days between. Anything that does not parse is
     returned in `unparsed` so it can be reported instead of vanishing. */
  function parseDates(text, now) {
    var ref = (now && typeof now.getTime === 'function') ? now : new Date();
    var raw = String(text == null ? '' : text);
    var out = {}, unparsed = [], warnings = [];

    raw.split(/\r?\n|,|;|&|\band\b|\by\b|\/{2,}/i).forEach(function (chunk) {
      var part = chunk.trim();
      if (!part) return;
      // A range: "8/25/26 - 8/27/26", "8/25 to 8/27", "8/25 al 8/27".
      var range = part.split(/\s+(?:-|–|to|through|thru|al|hasta)\s+/i);
      if (range.length === 2) {
        var a = parseOne(range[0], ref), b = parseOne(range[1], ref);
        if (a && b) {
          var span = daysBetween(a, b);
          if (span < 0) { warnings.push('"' + part + '" ends before it starts and was not used.'); return; }
          if (span > MAX_RANGE_DAYS) {
            warnings.push('"' + part + '" spans ' + (span + 1) + ' days, which looks like a typo. It was not used.');
            return;
          }
          for (var i = 0; i <= span; i++) out[addDays(a, i)] = true;
          return;
        }
      }
      var one = parseOne(part, ref);
      if (one) { out[one] = true; return; }
      // "8/25-8/27" with no spaces around the dash still has to work.
      var tight = part.split(/\s*[-–]\s*/);
      if (tight.length === 2) {
        var ta = parseOne(tight[0], ref), tb = parseOne(tight[1], ref);
        if (ta && tb) {
          var tspan = daysBetween(ta, tb);
          if (tspan >= 0 && tspan <= MAX_RANGE_DAYS) {
            for (var j = 0; j <= tspan; j++) out[addDays(ta, j)] = true;
            return;
          }
        }
      }
      unparsed.push(part);
    });

    if (unparsed.length) {
      warnings.push('Could not read ' + unparsed.map(function (x) { return '"' + x + '"'; }).join(', ') +
        ' as a date. The request was still created -- check the dates by hand.');
    }
    return { dates: Object.keys(out).sort(), unparsed: unparsed, warnings: warnings };
  }

  // Consecutive days become one request, so "8/25, 8/26, 8/27" is one row rather
  // than three, while "8/25, 8/29" stays two.
  function groupRanges(dates) {
    var out = [];
    (dates || []).forEach(function (d) {
      var last = out[out.length - 1];
      if (last && daysBetween(last.end, d) === 1) last.end = d;
      else out.push({ start: d, end: d });
    });
    return out.map(function (r) { return { start: r.start, end: r.end, days: daysBetween(r.start, r.end) + 1 }; });
  }

  /* ---------- roster ----------
     The form gives a name and the roster is keyed by badge, so name is the only
     bridge. A name held by two people cannot be resolved and is reported rather
     than assigned to whichever came first. */
  function buildNameIndex(profiles, rosterKey) {
    var byName = new Map();
    (profiles || []).forEach(function (p) {
      var k = rosterKey(p.name);
      if (!k) return;
      if (byName.has(k)) byName.set(k, null);       // ambiguous
      else byName.set(k, p);
    });
    return byName;
  }
  function resolveBadge(name, byName, rosterKey) {
    var k = rosterKey(name);
    if (!k) return { badge: '', how: '', ambiguous: false };
    if (!byName.has(k)) return { badge: '', how: '', ambiguous: false };
    var hit = byName.get(k);
    if (!hit) return { badge: '', how: '', ambiguous: true };
    return { badge: hit.badge, how: 'name', ambiguous: false, market: hit.market || '' };
  }

  /* ---------- Power Automate payload shapes ----------
     Building a JSON body by splicing answers into a string template breaks the
     moment someone types a newline or a double quote -- and "Which date(s)" is a
     multi-line box, so that is a matter of time, not luck.

     So the flow may instead send the whole "Get response details" body untouched
     as `response`, plus a `fields` map naming which question id holds what. Every
     value in the flow's own JSON is then a static id, and the free text never
     touches the template.

         { language, responseId, fields: { name: 'r6fc...', dates: 'r0ca...' },
           response: <the whole Get response details body> }

     The flat shape still works, so an existing flow does not have to change. */
  var CANONICAL = ['name', 'shift', 'location', 'dates', 'duration', 'hours', 'reason', 'email'];

  function normalizeSubmission(body) {
    body = body || {};
    var resp = body.response;
    if (!resp || typeof resp !== 'object') return body;
    var map = body.fields || {};
    var out = {
      language: body.language,
      responseId: body.responseId,
      submittedAt: body.submittedAt
    };
    CANONICAL.forEach(function (k) {
      if (body[k] != null && body[k] !== '') { out[k] = body[k]; return; }
      var id = map[k];
      if (!id) return;
      // Forms sometimes prefixes the key; accept it with or without.
      var v = resp[id];
      if (v == null) v = resp['body/' + id];
      if (v != null) out[k] = v;
    });
    // Fall back to the response's own id when the flow did not send one.
    if (!out.responseId && resp.responseId) out.responseId = resp.responseId;
    if (!out.submittedAt && resp.submitDate) out.submittedAt = resp.submitDate;
    return out;
  }

  /* ---------- a submission -> time-off records ----------
     sub:  { name, shift, location, dates, duration, hours, reason, language,
             responseId, submittedAt }
     opts: { profiles, rosterKey, now } */
  function toRequests(sub, opts) {
    sub = normalizeSubmission(sub);
    opts = opts || {};
    var rosterKey = opts.rosterKey || function (v) { return String(v || '').toLowerCase().trim(); };
    var now = (opts.now && typeof opts.now.getTime === 'function') ? opts.now : new Date();
    var warnings = [];

    var parsed = parseDates(sub.dates, now);
    warnings = warnings.concat(parsed.warnings);

    var dur = durationOf(sub.duration);
    if (!dur) warnings.push('The full/partial day answer was blank or unrecognised ("' +
      String(sub.duration == null ? '' : sub.duration) + '"); treated as a full day.');
    var partial = dur === 'partial';
    var statedHours = Number(sub.hours);
    var perDay = partial
      ? (isFinite(statedHours) && statedHours > 0 ? statedHours : PARTIAL_DAY_HOURS)
      : FULL_DAY_HOURS;
    if (partial && !(isFinite(statedHours) && statedHours > 0)) {
      warnings.push('A partial day was requested but no hours were given; recorded as ' +
        PARTIAL_DAY_HOURS + ' hours. Confirm with the associate.');
    }

    var byName = opts.byName || buildNameIndex(opts.profiles, rosterKey);
    var hit = resolveBadge(sub.name, byName, rosterKey);
    if (hit.ambiguous) {
      warnings.push('More than one associate is called "' + sub.name +
        '", so this request was not attached to a profile. Assign it by hand.');
    } else if (!hit.badge) {
      warnings.push('"' + sub.name + '" is not on the current assignment roster, so this request ' +
        'is not attached to a profile.');
    }

    var ranges = groupRanges(parsed.dates);
    if (partial && ranges.some(function (r) { return r.days > 1; })) {
      warnings.push('A partial day was requested across more than one date; ' + perDay +
        ' hours were recorded for each day.');
    }

    var base = requestId(sub, now);
    var records = ranges.map(function (r, i) {
      return {
        id: base + '-' + i,
        badge: hit.badge,
        name: sub.name || '',
        type: 'PTO',
        start: r.start,
        end: r.end,
        hours: perDay * r.days,
        status: 'Received',        // the pipeline's first state; see timeoff-core.js
        shift: sub.shift || '',
        location: sub.location || '',
        source: sub.language === 'es' ? 'Form (Spanish)' : 'Form (English)',
        submittedAt: sub.submittedAt || now.toISOString(),
        notes: noteFor(sub, dur, parsed)
      };
    });

    return {
      records: records,
      warnings: warnings,
      matched: !!hit.badge,
      ambiguous: hit.ambiguous,
      dates: parsed.dates,
      unparsed: parsed.unparsed
    };
  }

  /* The id is derived from the Forms response id, so Power Automate re-running a
     flow updates the same request rather than creating a second one. Without a
     response id it falls back to the person and what they typed, which is stable
     for the same submission and different for a genuinely new one. */
  function requestId(sub, now) {
    var rid = sub.responseId != null ? String(sub.responseId).trim() : '';
    if (rid) return 'FORM-' + rid.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    return 'FORM-' + hash([sub.name, sub.dates, sub.duration, sub.location].join('|')) +
      '-' + (now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()));
  }
  function hash(s) {
    var h = 0, str = String(s == null ? '' : s);
    for (var i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
    return Math.abs(h).toString(36);
  }

  // The raw submission, kept on the record so a reviewer can see what was
  // actually typed rather than only the interpretation of it.
  function noteFor(sub, dur, parsed) {
    var bits = [];
    if (dur === 'partial') bits.push('Partial day');
    if (sub.shift) bits.push('Shift ' + sub.shift);
    if (sub.location) bits.push('Location ' + sub.location);
    if (sub.reason) bits.push(String(sub.reason).slice(0, 200));
    if (parsed.unparsed.length) bits.push('Unread dates: ' + parsed.unparsed.join(' | '));
    bits.push('Requested: ' + String(sub.dates == null ? '' : sub.dates).replace(/\s+/g, ' ').slice(0, 120));
    return bits.join(' · ');
  }

  var api = {
    FULL_DAY_HOURS: FULL_DAY_HOURS,
    PARTIAL_DAY_HOURS: PARTIAL_DAY_HOURS,
    MAX_RANGE_DAYS: MAX_RANGE_DAYS,
    CANONICAL: CANONICAL,
    normalizeSubmission: normalizeSubmission,
    durationOf: durationOf,
    parseOne: parseOne,
    parseDates: parseDates,
    groupRanges: groupRanges,
    buildNameIndex: buildNameIndex,
    resolveBadge: resolveBadge,
    requestId: requestId,
    toRequests: toRequests
  };
  root.FormIntake = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
