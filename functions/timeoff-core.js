/* GEODIS Management Suite -- the time-off status pipeline.
 *
 * A PTO request moves through a pipeline, not a yes/no. The vocabulary lives
 * here so the browser, the Cloud Function, and the form intake cannot disagree
 * about what a status means -- particularly which ones excuse an absence, since
 * that decides whether attendance points apply.
 *
 * The machinery underneath (normalising, legacy aliases, the change log, the
 * actor) is shared with every other pipeline in the suite -- see pipeline-core.js.
 */
(function (root, Pipeline) {
  'use strict';

  /* The pipeline, in order. `resolved` is the one that carries weight: an excused
     request means the absence is authorised and no attendance points apply.
     Being SENT for approval is not the same as having it, so it is not excused. */
  var STATUSES = [
    { key: 'Received', label: 'Received', cls: 'pending', resolved: false },
    { key: 'Sent for Client Approval', label: 'Sent for client approval', cls: 'pending', resolved: false },
    { key: 'Approved', label: 'Approved', cls: '', resolved: true },
    { key: 'Submitted to Payroll', label: 'Submitted to payroll', cls: '', resolved: true },
    { key: 'Completed', label: 'Completed', cls: '', resolved: true, terminal: true },
    { key: 'Denied', label: 'Denied', cls: 'closed', resolved: false, terminal: true },
    { key: 'Cancelled', label: 'Cancelled', cls: 'closed', resolved: false, terminal: true }
  ];

  var pipeline = Pipeline.create({
    statuses: STATUSES,
    defaultStatus: 'Received',
    // Requests written before the pipeline existed say "Pending". Same thing.
    legacy: { 'Pending': 'Received', 'pending': 'Received', 'New': 'Received' }
  });

  // isExcused is the time-off name for the pipeline's resolved state: the absence
  // is authorised, so no attendance points apply.
  pipeline.isExcused = pipeline.isResolved;

  /* ---------- which days a request covers ----------
     So that an approved absence can answer for itself on the day it happens:
     the floor should read the person as on PTO rather than missing, and no
     attendance points should follow.

     Only EXCUSED requests count. One still sitting at "Received" is a request,
     not permission -- treating it as cover would let anybody clear an
     infraction by filing paperwork after the fact. Denied and Cancelled are
     finished but were never permission either, which is exactly the
     resolved/terminal distinction the pipeline already draws. */
  function dayOf(v) {
    var m = String(v == null ? '' : v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[0] : '';
  }
  /* A request with no end covers its start day alone. One with no start covers
     nothing -- a request that cannot say when it is for must not silently
     excuse every day there is. */
  function coversDate(req, iso) {
    if (!req || !iso) return false;
    var start = dayOf(req.start);
    if (!start) return false;
    var end = dayOf(req.end) || start;
    if (end < start) { var t = start; start = end; end = t; }
    return iso >= start && iso <= end;
  }

  /* badge -> the excused requests for that person. Built once per render rather
     than scanned per row: coverage asks this question for every person on the
     floor, several times a day. */
  function excusedIndex(records, normBadge) {
    var norm = normBadge || function (v) { return String(v == null ? '' : v).trim(); };
    var m = new Map();
    (records || []).forEach(function (r) {
      if (!r || !r.badge || !pipeline.isExcused(r.status)) return;
      var k = norm(r.badge);
      if (!k) return;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    });
    return m;
  }
  // The request covering that person on that day, or null. The first match wins;
  // overlapping approved requests for one day are the same answer twice.
  function excusedOn(index, badge, iso) {
    if (!index || !badge) return null;
    var list = index.get(String(badge)) || [];
    for (var i = 0; i < list.length; i++) {
      if (coversDate(list[i], iso)) return list[i];
    }
    return null;
  }

  pipeline.coversDate = coversDate;
  pipeline.excusedIndex = excusedIndex;
  pipeline.excusedOn = excusedOn;

  root.TimeOffCore = pipeline;
  if (typeof module !== 'undefined' && module.exports) module.exports = pipeline;
})(
  typeof window !== 'undefined' ? window : this,
  typeof require !== 'undefined' ? require('./pipeline-core.js')
    : (typeof window !== 'undefined' ? window.PipelineCore : this.PipelineCore)
);
