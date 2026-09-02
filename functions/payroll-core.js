/* GEODIS Management Suite -- payroll.
 *
 * Two jobs, both about hours that move after somebody thought they were final.
 *
 *   1. Discrepancies raised by the team on the "GEODIS Payroll Discrepancy Form".
 *      Same shape as the PTO intake: a name that has to reach a badge, a date, and
 *      free text describing what is wrong.
 *
 *   2. Hours submitted to Beeline, watched for change. Each pull of the hours
 *      report is compared with the one before it, and anything that moved AFTER
 *      the pay period closed is the thing worth seeing -- that is money already
 *      out the door being changed behind it.
 *
 * On the close date: a period is only flagged as changed-after-close when a close
 * time has actually been recorded for it. No close date means no flag, rather
 * than a guessed cutoff that would either cry wolf or stay silent.
 */
(function (root, Pipeline) {
  'use strict';

  /* ---------- discrepancy pipeline ----------
     `resolved` means the hours were actually put right. "Submitted to Payroll"
     is not resolved: it has been handed over, not yet fixed. */
  var STATUSES = [
    { key: 'Received', label: 'Received', cls: 'pending', resolved: false },
    { key: 'Researching', label: 'Researching', cls: 'pending', resolved: false },
    { key: 'Submitted to Payroll', label: 'Submitted to payroll', cls: 'pending', resolved: false },
    { key: 'Corrected', label: 'Corrected', cls: '', resolved: true, terminal: true },
    { key: 'No Adjustment Needed', label: 'No adjustment needed', cls: 'closed', resolved: false, terminal: true },
    { key: 'Cancelled', label: 'Cancelled', cls: 'closed', resolved: false, terminal: true }
  ];
  var pipeline = Pipeline.create({
    statuses: STATUSES,
    defaultStatus: 'Received',
    legacy: { 'Pending': 'Received', 'Open': 'Received', 'New': 'Received' }
  });

  /* ---------- dates ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function isoOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  /* The discrepancy form uses a date PICKER, not free text, so this only has to
     cope with the handful of shapes Forms and Power Automate emit -- an ISO
     date, an ISO timestamp, or M/D/YYYY. Anything else returns '' rather than a
     guess. */
  function parseDate(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
    var mdy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (mdy) {
      var yr = Number(mdy[3]);
      if (yr < 100) yr += 2000;
      var probe = new Date(yr, Number(mdy[1]) - 1, Number(mdy[2]));
      if (probe.getFullYear() === yr && probe.getMonth() === Number(mdy[1]) - 1) return isoOf(probe);
    }
    return '';
  }

  /* Payroll weeks end on Sunday, and the form asks for the week-ending date when
     a discrepancy spans days. Normalising to the week end is what lets a
     discrepancy line up with the hours snapshot for the same period. */
  function weekEndingOf(isoDate) {
    var d = new Date(String(isoDate) + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    var shift = (7 - d.getDay()) % 7;      // 0 = Sunday, already the week end
    d.setDate(d.getDate() + shift);
    return isoOf(d);
  }

  /* ---------- a form submission -> a discrepancy record ----------
     sub:  { name, location, date, details, responseId, submittedAt }
     opts: { byName, rosterKey, now } */
  function toDiscrepancy(sub, opts) {
    sub = sub || {};
    opts = opts || {};
    var rosterKey = opts.rosterKey || function (v) { return String(v || '').toLowerCase().trim(); };
    var now = (opts.now && typeof opts.now.getTime === 'function') ? opts.now : new Date();
    var warnings = [];

    var date = parseDate(sub.date);
    if (!date) {
      warnings.push('The date of the discrepancy could not be read ("' +
        String(sub.date == null ? '' : sub.date) + '"). Set it by hand.');
    }

    var hit = { badge: '', ambiguous: false };
    if (opts.byName) {
      var k = rosterKey(sub.name);
      if (k && opts.byName.has(k)) {
        var p = opts.byName.get(k);
        if (p) hit = { badge: p.badge, ambiguous: false, market: p.market || '' };
        else hit = { badge: '', ambiguous: true };
      }
    }
    if (hit.ambiguous) {
      warnings.push('More than one associate is called "' + sub.name +
        '", so this was not attached to a profile. Assign it by hand.');
    } else if (!hit.badge) {
      warnings.push('"' + sub.name + '" is not on the current assignment roster, so this ' +
        'discrepancy is not attached to a profile.');
    }

    var rid = sub.responseId != null ? String(sub.responseId).trim() : '';
    var id = rid
      ? 'PDF-' + rid.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
      : 'PDF-' + hashOf([sub.name, sub.date, sub.details].join('|'));

    return {
      record: {
        id: id,
        badge: hit.badge,
        name: sub.name || '',
        location: sub.location || '',
        date: date,
        weekEnding: date ? weekEndingOf(date) : '',
        details: String(sub.details == null ? '' : sub.details).slice(0, 2000),
        status: pipeline.DEFAULT_STATUS,
        source: 'Payroll discrepancy form',
        submittedAt: sub.submittedAt || now.toISOString()
      },
      warnings: warnings,
      matched: !!hit.badge,
      ambiguous: hit.ambiguous
    };
  }
  function hashOf(s) {
    var h = 0, str = String(s == null ? '' : s);
    for (var i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
    return Math.abs(h).toString(36);
  }

  /* ---------- hours submitted to Beeline ----------
     A snapshot is one pull of the hours report for one period:
       { weekEnding, takenAt, rows: [{ badge, name, hours, location, status }] }

     Rows are keyed by badge AND week-ending, because the same person appears in
     every period. */
  function rowKey(r) {
    return String(r.badge || '').trim() + '|' + String(r.weekEnding || '').trim();
  }
  function normalizeHours(rows, weekEnding) {
    var out = new Map();
    (rows || []).forEach(function (r) {
      if (!r) return;
      var badge = String(r.badge == null ? '' : r.badge).trim();
      if (!badge) return;
      var hours = Number(r.hours);
      out.set(badge, {
        badge: badge,
        name: String(r.name == null ? '' : r.name).trim(),
        hours: isFinite(hours) ? hours : 0,
        location: String(r.location == null ? '' : r.location).trim(),
        status: String(r.status == null ? '' : r.status).trim(),
        weekEnding: r.weekEnding || weekEnding || ''
      });
    });
    return out;
  }

  /* What moved between two pulls.

     `afterClose` is the point of the whole exercise: hours that changed once the
     period was closed. It is only ever set when a close time was actually
     recorded -- an unset close date means no flag, not a guessed cutoff. */
  function compareHours(prev, next, opts) {
    opts = opts || {};
    var closesAt = opts.closesAt ? Date.parse(opts.closesAt) : NaN;
    var takenAt = next && next.takenAt ? next.takenAt : new Date().toISOString();
    var afterClose = !isNaN(closesAt) && Date.parse(takenAt) > closesAt;

    var before = normalizeHours(prev && prev.rows, prev && prev.weekEnding);
    var after = normalizeHours(next && next.rows, next && next.weekEnding);
    var changes = [];

    after.forEach(function (row, badge) {
      var was = before.get(badge);
      if (!was) {
        // Nothing to compare against on the very first pull -- that is a baseline,
        // not a change, or every person would read as newly added.
        if (!prev || !prev.rows) return;
        changes.push(change('added', row, 0, row.hours, takenAt, afterClose));
        return;
      }
      if (round2(was.hours) !== round2(row.hours)) {
        changes.push(change('changed', row, was.hours, row.hours, takenAt, afterClose));
      }
    });
    before.forEach(function (row, badge) {
      if (!after.has(badge)) changes.push(change('removed', row, row.hours, 0, takenAt, afterClose));
    });

    changes.sort(function (a, b) {
      return Math.abs(b.delta) - Math.abs(a.delta) || String(a.name).localeCompare(String(b.name));
    });
    return {
      weekEnding: (next && next.weekEnding) || '',
      takenAt: takenAt,
      afterClose: afterClose,
      closesAt: opts.closesAt || '',
      baseline: !prev || !prev.rows,
      changes: changes,
      summary: summarize(changes, before, after)
    };
  }
  function change(kind, row, from, to, at, afterClose) {
    return {
      kind: kind,
      badge: row.badge,
      name: row.name,
      location: row.location,
      weekEnding: row.weekEnding,
      from: round2(from),
      to: round2(to),
      delta: round2(to - from),
      at: at,
      afterClose: afterClose
    };
  }
  function changeKey(c) {
    c = c || {};
    return 'CHG-' + hashOf([c.badge, c.weekEnding, c.at, c.kind, c.from, c.to].join('|'));
  }
  function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
  function summarize(changes, before, after) {
    var added = 0, removed = 0, changed = 0, net = 0;
    changes.forEach(function (c) {
      if (c.kind === 'added') added++;
      else if (c.kind === 'removed') removed++;
      else changed++;
      net += c.delta;
    });
    var total = 0;
    after.forEach(function (r) { total += r.hours; });
    return {
      people: after.size,
      priorPeople: before.size,
      totalHours: round2(total),
      added: added, removed: removed, changed: changed,
      net: round2(net),
      touched: changes.length
    };
  }

  var api = {
    STATUSES: STATUSES,
    pipeline: pipeline,
    parseDate: parseDate,
    weekEndingOf: weekEndingOf,
    toDiscrepancy: toDiscrepancy,
    normalizeHours: normalizeHours,
    compareHours: compareHours,
    rowKey: rowKey,
    changeKey: changeKey
  };
  root.PayrollCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(
  typeof window !== 'undefined' ? window : this,
  typeof require !== 'undefined' ? require('./pipeline-core.js')
    : (typeof window !== 'undefined' ? window.PipelineCore : this.PipelineCore)
);
