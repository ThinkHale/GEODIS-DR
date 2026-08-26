/* GEODIS Management Suite -- status pipelines and the change log behind them.
 *
 * Time off has a pipeline. Payroll discrepancies have a different one. Both need
 * the same things underneath: a vocabulary that says what each status MEANS,
 * tolerance for older data written before the pipeline existed, and an
 * append-only record of who moved something and when.
 *
 * That machinery lives here once. A pipeline is built by describing its statuses;
 * everything else -- normalising, legacy aliases, the log, the actor -- comes free
 * and behaves identically wherever it is used.
 *
 * On actors: there is no authentication yet, so an actor is a display name typed
 * into a browser. The shape carries an id and a source so that when real sign-in
 * arrives, only the code that BUILDS an actor changes. Nothing that reads a log
 * has to know the difference.
 */
(function (root) {
  'use strict';

  var MAX_LOG = 40;

  /* ---------- who did it ---------- */
  function actorOf(name, id, source) {
    return {
      id: String(id || '').slice(0, 64),
      name: String(name || '').trim().slice(0, 80) || 'Unknown',
      source: source || 'local'
    };
  }
  function describeActor(a) {
    if (!a) return 'unknown';
    return a.name + (a.source && a.source !== 'local' ? ' (' + a.source + ')' : '');
  }
  function lastChange(record) {
    var log = (record && record.statusHistory) || [];
    return log.length ? log[log.length - 1] : null;
  }

  /* ---------- a pipeline ----------
     spec: { statuses: [{key, label, cls, resolved?, terminal?}], defaultStatus,
             legacy: {oldValue: newValue} } */
  function create(spec) {
    var statuses = spec.statuses;
    var defaultStatus = spec.defaultStatus || statuses[0].key;
    var legacy = spec.legacy || {};
    var byKey = {};
    statuses.forEach(function (s) { byKey[s.key] = s; });

    function normalizeStatus(v) {
      var s = String(v == null ? '' : v).trim();
      if (!s) return defaultStatus;
      if (byKey[s]) return s;
      if (legacy[s]) return legacy[s];
      var lower = s.toLowerCase();
      if (legacy[lower]) return legacy[lower];
      // Case-insensitive last resort, so "approved" is not treated as unknown.
      var hit = statuses.filter(function (x) { return x.key.toLowerCase() === lower; })[0];
      return hit ? hit.key : s;
    }
    function statusMeta(v) {
      var key = normalizeStatus(v);
      // An unrecognised status is shown as itself rather than coerced into the
      // pipeline -- silently relabelling someone's data is worse than an oddity,
      // and it must never be treated as a resolved state.
      return byKey[key] || { key: key, label: key, cls: 'unknown', resolved: false, unknown: true };
    }
    function isKnown(v) { return !!byKey[normalizeStatus(v)]; }
    function isResolved(v) { return !!statusMeta(v).resolved; }
    /* Still waiting on somebody. Not the same as "not resolved": a denied or
       cancelled item is finished, it just did not end in the resolved state. */
    function needsAction(v) {
      var m = statusMeta(v);
      return !m.resolved && !m.terminal;
    }

    function entryFor(status, actor, when, note) {
      var e = {
        status: status,
        at: when.toISOString(),
        by: actor ? actor.name : 'Unknown',
        byId: actor ? actor.id : '',
        source: actor ? actor.source : 'local'
      };
      if (note) e.note = note;
      return e;
    }
    function appendLog(record, entry, seedStatus) {
      var log = Array.isArray(record.statusHistory) ? record.statusHistory.slice() : [];
      // Seed the log with where the record started, so a first change does not
      // look like the item arrived already in that state.
      if (!log.length && seedStatus && seedStatus !== entry.status) {
        log.push({
          status: seedStatus,
          at: record.submittedAt || record.updatedAt || entry.at,
          by: record.source || 'Unknown',
          byId: '',
          source: 'import'
        });
      }
      log.push(entry);
      return log.length > MAX_LOG ? log.slice(-MAX_LOG) : log;
    }

    /* Returns a patch rather than mutating, so the caller decides when it is
       persisted and the same function serves the browser and any future
       server-side automation. */
    function applyStatus(record, status, actor, now) {
      record = record || {};
      var when = (now && typeof now.toISOString === 'function') ? now : new Date();
      var next = normalizeStatus(status);
      var entry = entryFor(next, actor, when);
      var log = appendLog(record, entry, record.status ? normalizeStatus(record.status) : '');
      return {
        id: record.id,
        status: next,
        statusUpdatedAt: entry.at,
        statusUpdatedBy: entry.by,
        statusHistory: log
      };
    }

    /* Linking a record that arrived without a badge -- a name typed differently
       from the roster. Logged the same way a status change is, because it is
       just as much a decision somebody made. */
    function applyConnection(record, badge, actor, now) {
      record = record || {};
      var when = (now && typeof now.toISOString === 'function') ? now : new Date();
      var entry = entryFor(normalizeStatus(record.status), actor, when, 'Linked to badge ' + badge);
      var log = Array.isArray(record.statusHistory) ? record.statusHistory.slice() : [];
      log.push(entry);
      if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
      return {
        id: record.id,
        badge: String(badge || ''),
        connectedBy: entry.by,
        connectedAt: entry.at,
        statusHistory: log
      };
    }

    return {
      STATUSES: statuses,
      STATUS_KEYS: statuses.map(function (s) { return s.key; }),
      DEFAULT_STATUS: defaultStatus,
      MAX_LOG: MAX_LOG,
      normalizeStatus: normalizeStatus,
      statusMeta: statusMeta,
      isKnown: isKnown,
      isResolved: isResolved,
      needsAction: needsAction,
      applyStatus: applyStatus,
      applyConnection: applyConnection,
      actorOf: actorOf,
      describeActor: describeActor,
      lastChange: lastChange
    };
  }

  var api = { MAX_LOG: MAX_LOG, create: create, actorOf: actorOf, describeActor: describeActor, lastChange: lastChange };
  root.PipelineCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
