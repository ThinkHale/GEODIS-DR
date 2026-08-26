/* GEODIS Management Suite -- time-off status workflow and change log.
 *
 * A PTO request moves through a pipeline, not a yes/no. The vocabulary lives
 * here so the browser, the Cloud Function, and the form intake cannot disagree
 * about what a status means -- particularly which ones excuse an absence, since
 * that decides whether attendance points apply.
 *
 * There is no authentication yet, so "who changed it" is recorded on the honour
 * system: a display name the user sets once in their browser. Everything that
 * writes a status goes through applyStatus(), which stamps an actor and appends
 * to a change log. When real sign-in arrives, the only thing that has to change
 * is where the actor comes from -- the record shape and every reader of it stay
 * as they are. That is the point of doing it now.
 */
(function (root) {
  'use strict';

  /* The pipeline, in order. `excused` is the one that carries weight: an excused
     request means the absence is authorised and no attendance points apply.
     Being SENT for approval is not the same as having it, so it is not excused. */
  var STATUSES = [
    { key: 'Received', label: 'Received', cls: 'pending', excused: false },
    { key: 'Sent for Client Approval', label: 'Sent for client approval', cls: 'pending', excused: false },
    { key: 'Approved', label: 'Approved', cls: '', excused: true },
    { key: 'Submitted to Payroll', label: 'Submitted to payroll', cls: '', excused: true },
    { key: 'Completed', label: 'Completed', cls: '', excused: true, terminal: true },
    { key: 'Denied', label: 'Denied', cls: 'closed', excused: false, terminal: true },
    { key: 'Cancelled', label: 'Cancelled', cls: 'closed', excused: false, terminal: true }
  ];
  var DEFAULT_STATUS = 'Received';
  var MAX_LOG = 40;

  // Requests written before the pipeline existed say "Pending". Same thing.
  var LEGACY = { 'Pending': 'Received', 'pending': 'Received', 'New': 'Received' };

  var BY_KEY = {};
  STATUSES.forEach(function (s) { BY_KEY[s.key] = s; });

  function normalizeStatus(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return DEFAULT_STATUS;
    if (BY_KEY[s]) return s;
    if (LEGACY[s]) return LEGACY[s];
    // Case-insensitive last resort, so "approved" is not treated as unknown.
    var hit = STATUSES.filter(function (x) { return x.key.toLowerCase() === s.toLowerCase(); })[0];
    return hit ? hit.key : s;
  }
  function statusMeta(v) {
    return BY_KEY[normalizeStatus(v)] ||
      // An unrecognised status is shown as itself rather than coerced into the
      // pipeline -- silently relabelling someone's data is worse than an oddity.
      { key: normalizeStatus(v), label: normalizeStatus(v), cls: 'unknown', excused: false, unknown: true };
  }
  function isExcused(v) { return !!statusMeta(v).excused; }
  /* Still waiting on somebody. Not the same as "not approved": a denied or
     cancelled request is finished, it just did not end in time off. This is what
     the overview counts, so the number means "needs attention", not "not yet
     approved". */
  function needsAction(v) {
    var m = statusMeta(v);
    return !m.excused && !m.terminal;
  }
  function isKnown(v) { return !!BY_KEY[normalizeStatus(v)]; }

  /* ---------- who did it ----------
     Today an actor is a name typed into this browser. The shape already carries
     an id and a source so a real identity can replace it without touching any
     reader of the log. */
  function actorOf(name, id, source) {
    return {
      id: String(id || '').slice(0, 64),
      name: String(name || '').trim().slice(0, 80) || 'Unknown',
      source: source || 'local'
    };
  }
  function describeActor(a) {
    if (!a) return 'unknown';
    return a.name + (a.source === 'local' ? '' : ' (' + a.source + ')');
  }

  /* Every status change returns a patch rather than mutating, so the caller
     decides when it is persisted and the same function serves the browser and
     any future server-side automation. */
  function applyStatus(record, status, actor, now) {
    record = record || {};
    var when = (now && typeof now.toISOString === 'function') ? now : new Date();
    var next = normalizeStatus(status);
    var entry = {
      status: next,
      at: when.toISOString(),
      by: actor ? actor.name : 'Unknown',
      byId: actor ? actor.id : '',
      source: actor ? actor.source : 'local'
    };
    var log = Array.isArray(record.statusHistory) ? record.statusHistory.slice() : [];
    // Seed the log with where the record started, so the first change does not
    // look like the request appeared already in that state.
    if (!log.length && record.status && normalizeStatus(record.status) !== next) {
      log.push({
        status: normalizeStatus(record.status),
        at: record.submittedAt || record.updatedAt || when.toISOString(),
        by: record.source ? record.source : 'Unknown',
        byId: '', source: 'import'
      });
    }
    log.push(entry);
    if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
    return {
      id: record.id,
      status: next,
      statusUpdatedAt: entry.at,
      statusUpdatedBy: entry.by,
      statusHistory: log
    };
  }

  /* Linking a request that arrived without a badge -- a name typed differently
     on the form. Recorded the same way a status change is, because it is just as
     much a decision somebody made. */
  function applyConnection(record, badge, actor, now) {
    record = record || {};
    var when = (now && typeof now.toISOString === 'function') ? now : new Date();
    var log = Array.isArray(record.statusHistory) ? record.statusHistory.slice() : [];
    log.push({
      status: normalizeStatus(record.status),
      at: when.toISOString(),
      by: actor ? actor.name : 'Unknown',
      byId: actor ? actor.id : '',
      source: actor ? actor.source : 'local',
      note: 'Linked to badge ' + badge
    });
    if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
    return {
      id: record.id,
      badge: String(badge || ''),
      connectedBy: actor ? actor.name : 'Unknown',
      connectedAt: when.toISOString(),
      statusHistory: log
    };
  }

  function lastChange(record) {
    var log = (record && record.statusHistory) || [];
    return log.length ? log[log.length - 1] : null;
  }

  var api = {
    STATUSES: STATUSES,
    STATUS_KEYS: STATUSES.map(function (s) { return s.key; }),
    DEFAULT_STATUS: DEFAULT_STATUS,
    MAX_LOG: MAX_LOG,
    normalizeStatus: normalizeStatus,
    statusMeta: statusMeta,
    isExcused: isExcused,
    needsAction: needsAction,
    isKnown: isKnown,
    actorOf: actorOf,
    describeActor: describeActor,
    applyStatus: applyStatus,
    applyConnection: applyConnection,
    lastChange: lastChange
  };
  root.TimeOffCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
