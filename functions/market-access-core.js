/* Server-side market partitioning for the GEODIS Management Suite.
 *
 * A non-empty account `markets` list is a restriction. Restricted accounts may
 * see or change a record only when its market can be resolved unambiguously and
 * that market is in the account's list. Missing and contradictory ownership is
 * deliberately denied: browser filtering is a convenience, not authorization.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MarketAccessCore = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var UNASSIGNED = { '': true, unassigned: true, unknown: true, other: true, none: true,
    'n/a': true, na: true, all: true, '—': true };
  var BADGE_COLLECTIONS = {
    attendance: true, timeoff: true, associatePto: true, shifts: true,
    contacts: true, tasks: true, discrepancies: true, timeclockLinks: true,
    performance: true, reqCandidates: true, schedule: true, coverage: true,
    payroll: true
  };
  var EID_COLLECTIONS = {
    shifts: true, contacts: true, timeclockLinks: true, schedule: true, coverage: true
  };
  var DIRECT_MARKET_COLLECTIONS = { requisitions: true, locations: true, tasks: true };
  var LOCATION_COLLECTIONS = {
    requisitions: true, shifts: true, shiftTypes: true, shiftKey: true,
    schedule: true, coverage: true, payroll: true
  };

  function text(v) { return String(v == null ? '' : v).trim(); }
  function idKey(v) { return text(v).toLowerCase(); }
  function normalizeMarket(v) {
    var market = text(v).replace(/\s+/g, ' ');
    var key = market.toLowerCase();
    return UNASSIGNED[key] ? '' : key;
  }
  function hasRestriction(user) {
    // Even an invalid non-empty list remains a restriction to no usable markets.
    // It must never collapse to the empty-list meaning of "all markets".
    return !!(user && Array.isArray(user.markets) && user.markets.length);
  }
  function allowedMarkets(user) {
    var out = new Set();
    (user && Array.isArray(user.markets) ? user.markets : []).forEach(function (m) {
      var key = normalizeMarket(m);
      if (key) out.add(key);
    });
    return out;
  }

  function indexAdd(index, rawKey, rawMarket) {
    var key = idKey(rawKey), market = normalizeMarket(rawMarket);
    if (!key || !market) return;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(market);
  }
  function locationKeys(value) {
    var raw = text(value), out = [];
    if (!raw) return out;
    out.push(idKey(raw));
    // Beeline locations commonly begin "4805 - street...". The configured
    // location code is the authoritative part of that value.
    var site = raw.match(/^([A-Za-z0-9]+)\s*(?:-|$)/);
    if (site) out.push(idKey(site[1]));
    // WFM paths end in the configured site code:
    // "GEODIS/US/CL/.../CL1523/1523" -> "1523".
    var parts = raw.split('/').map(function (part) { return idKey(part); }).filter(Boolean);
    if (parts.length) out.push(parts[parts.length - 1]);
    return out.filter(function (key, i) { return out.indexOf(key) === i; });
  }
  function rosterNameKey(value) {
    var s = text(value).toLowerCase().replace(/[^a-z\s,]/g, '');
    var first = '', last = '';
    if (s.indexOf(',') !== -1) {
      var parts = s.split(',');
      last = (parts[0].trim().split(/\s+/)[0]) || '';
      first = ((parts[1] || '').trim().split(/\s+/)[0]) || '';
    } else {
      var tokens = s.trim().split(/\s+/).filter(Boolean);
      first = tokens[0] || '';
      last = tokens.length > 1 ? tokens[tokens.length - 1] : '';
    }
    return [first, last].filter(Boolean).sort().join(' ');
  }
  function identityKey(prefix, value) {
    var key = idKey(value);
    return key ? prefix + ':' + key : '';
  }
  function compileContext(context) {
    if (context && context._marketAccessCompiled) return context;
    context = context || {};
    var compiled = {
      _marketAccessCompiled: true,
      badge: new Map(), eid: new Map(), requisition: new Map(), location: new Map(),
      coverageKey: new Map()
    };
    var snapshot = Array.isArray(context.snapshotRecords) ? context.snapshotRecords
      : context.snapshot && Array.isArray(context.snapshot.records) ? context.snapshot.records : [];
    snapshot.forEach(function (r) {
      if (!r || r.marketVerified === false) return;
      indexAdd(compiled.badge, r.badge, r.market);
      indexAdd(compiled.eid, r.empNumber || r.eid, r.market);
      indexAdd(compiled.coverageKey, identityKey('b', r.badge), r.market);
      indexAdd(compiled.coverageKey, identityKey('w', r.empNumber || r.eid), r.market);
      indexAdd(compiled.coverageKey, identityKey('n', rosterNameKey(
        r.person || r.name || r.crmName || r.beeName)), r.market);
    });
    (Array.isArray(context.locations) ? context.locations : []).forEach(function (r) {
      if (!r) return;
      [r.id, r.code, r.name].forEach(function (key) { indexAdd(compiled.location, key, r.market); });
    });
    // Both a requisition's explicit market and its configured location are
    // evidence. Keeping both makes a disagreement a conflict for its candidates
    // too, rather than trusting whichever source happened to be indexed first.
    (Array.isArray(context.requisitions) ? context.requisitions : []).forEach(function (r) {
      if (!r) return;
      indexAdd(compiled.requisition, r.id, r.market);
      indexAdd(compiled.requisition, r.beelineReq, r.market);
      locationKeys(r.location || r.building).forEach(function (key) {
        var values = compiled.location.get(key);
        if (values) values.forEach(function (m) {
          indexAdd(compiled.requisition, r.id, m);
          indexAdd(compiled.requisition, r.beelineReq, m);
        });
      });
    });
    // Name-only and WFM-only coverage keys are resolved through the stored
    // schedule. The schedule person's badge/location evidence is evaluated
    // first; contradictory evidence deliberately adds both markets so a later
    // decision fails as conflicting rather than trusting one source.
    (Array.isArray(context.schedulePeople) ? context.schedulePeople : []).forEach(function (r) {
      if (!r) return;
      var markets = new Set();
      addIndex(markets, compiled.badge, r.badge);
      addIndex(markets, compiled.eid, r.wfmId || r.eid || r.empNumber);
      addLocation(markets, compiled.location, r.location);
      markets.forEach(function (market) {
        indexAdd(compiled.coverageKey, identityKey('n', rosterNameKey(r.name)), market);
      });
      // A malformed schedule location must not poison a badge/EID already
      // verified by the roster. The schedule only fills identity namespaces the
      // roster could not resolve itself; its name key remains conflict-aware.
      var badgeKey = idKey(r.badge), wfmKey = idKey(r.wfmId || r.eid || r.empNumber);
      if (badgeKey && !compiled.badge.has(badgeKey)) {
        markets.forEach(function (market) {
          indexAdd(compiled.coverageKey, identityKey('b', r.badge), market);
        });
      }
      if (wfmKey && !compiled.eid.has(wfmKey)) {
        markets.forEach(function (market) {
          indexAdd(compiled.coverageKey, identityKey('w', r.wfmId || r.eid || r.empNumber), market);
        });
      }
    });
    return compiled;
  }

  function addValue(markets, raw) {
    var market = normalizeMarket(raw);
    if (market) markets.add(market);
  }
  function addIndex(markets, index, rawKey) {
    var values = index.get(idKey(rawKey));
    if (values) values.forEach(function (m) { markets.add(m); });
  }
  function addLocation(markets, index, rawLocation) {
    locationKeys(rawLocation).forEach(function (key) {
      var values = index.get(key);
      if (values) values.forEach(function (m) { markets.add(m); });
    });
  }

  function resolveRecordMarkets(collection, record, context) {
    record = record || {};
    var indexes = compileContext(context), markets = new Set();
    var userRecord = collection === 'users';

    if (userRecord) {
      var rawMarkets = Array.isArray(record.markets) ? record.markets : [];
      var invalidMarket = rawMarkets.some(function (m) { return !normalizeMarket(m); });
      rawMarkets.forEach(function (m) { addValue(markets, m); });
      return { markets: Array.from(markets), resolved: markets.size > 0,
        conflict: invalidMarket, multipleAllowed: true };
    }

    // Only schemas that declare a market may use it as ownership evidence. A
    // stray property on a different collection must not turn into a grant.
    if (DIRECT_MARKET_COLLECTIONS[collection]) addValue(markets, record.market);
    if (BADGE_COLLECTIONS[collection]) addIndex(markets, indexes.badge, record.badge);
    if (EID_COLLECTIONS[collection]) {
      addIndex(markets, indexes.eid, record.eid || record.empNumber || record.wfmId);
    }
    if (collection === 'reqCandidates') addIndex(markets, indexes.requisition, record.reqId);
    if (LOCATION_COLLECTIONS[collection]) {
      addLocation(markets, indexes.location, record.location || record.building);
    }
    if (collection === 'coverage' && record.key) addIndex(markets, indexes.coverageKey, record.key);

    return { markets: Array.from(markets), resolved: markets.size > 0,
      conflict: markets.size > 1, multipleAllowed: false };
  }

  function recordDecision(user, collection, record, context) {
    if (!hasRestriction(user)) return { allowed: true, unrestricted: true, markets: [] };
    var resolved = resolveRecordMarkets(collection, record, context);
    if (!resolved.resolved) return { allowed: false, reason: 'unassigned', markets: [] };
    if (resolved.conflict) return { allowed: false, reason: 'conflicting-market', markets: resolved.markets };
    var allowed = allowedMarkets(user);
    var inScope = resolved.markets.every(function (m) { return allowed.has(m); });
    return { allowed: inScope, reason: inScope ? '' : 'outside-market', markets: resolved.markets };
  }

  function filterRecords(user, collection, records, context) {
    var list = Array.isArray(records) ? records : [];
    if (!hasRestriction(user)) return list.slice();
    var compiled = compileContext(context);
    return list.filter(function (record) {
      return recordDecision(user, collection, record, compiled).allowed;
    });
  }

  function recordIdentity(collection, record) {
    record = record || {};
    if (collection !== 'schedule') return text(record.id);
    var badge = identityKey('b', record.badge);
    if (badge) return badge;
    var wfm = identityKey('w', record.wfmId || record.eid || record.empNumber);
    if (wfm) return wfm;
    var name = rosterNameKey(record.name), locations = locationKeys(record.location);
    return name && locations.length ? 'n:' + name + '|l:' + locations[0] : '';
  }

  /* A restricted bulk upload replaces only the caller's resolvable market
     partition. Every out-of-scope or unresolved existing row is preserved.
     The whole request is rejected when an incoming row is not authorized or
     collides with a preserved row, because then a safe merge is not provable. */
  function mergeRestrictedReplace(user, collection, current, incoming, context) {
    current = Array.isArray(current) ? current : [];
    incoming = Array.isArray(incoming) ? incoming : [];
    if (!hasRestriction(user)) return { ok: true, records: incoming.slice(), restricted: false };

    var compiled = compileContext(context), incomingIds = new Set();
    for (var i = 0; i < incoming.length; i++) {
      var id = recordIdentity(collection, incoming[i]);
      var decision = recordDecision(user, collection, incoming[i], compiled);
      if (!decision.allowed) return { ok: false, reason: decision.reason, index: i };
      if (!id || incomingIds.has(id)) return { ok: false, reason: 'ambiguous-id', index: i };
      incomingIds.add(id);
    }

    var preserved = [], preservedIds = new Set();
    current.forEach(function (record) {
      if (recordDecision(user, collection, record, compiled).allowed) return;
      preserved.push(record);
      var id = recordIdentity(collection, record);
      if (id) preservedIds.add(id);
    });
    var collision = Array.from(incomingIds).some(function (id) { return preservedIds.has(id); });
    if (collision) return { ok: false, reason: 'preserved-id-collision' };
    return { ok: true, records: preserved.concat(incoming), restricted: true,
      preserved: preserved.length, replaced: current.length - preserved.length };
  }

  function filterSnapshot(user, snapshot) {
    snapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
    var records = Array.isArray(snapshot.records) ? snapshot.records : [];
    if (!hasRestriction(user)) return Object.assign({}, snapshot, { records: records.slice() });
    var allowed = allowedMarkets(user);
    var visible = records.filter(function (record) {
      if (record && record.marketVerified === false) return false;
      var market = normalizeMarket(record && record.market);
      return !!market && allowed.has(market);
    });
    var counts = {};
    Object.keys(snapshot.counts && typeof snapshot.counts === 'object' ? snapshot.counts : {}).forEach(function (key) {
      if (key !== 'dups' && key !== 'total' && key !== 'needsAction') counts[key] = 0;
    });
    visible.forEach(function (record) {
      var action = text(record && record.action);
      if (action) counts[action] = (counts[action] || 0) + 1;
    });
    if (counts.matched === undefined) counts.matched = 0;
    var duplicateBadges = new Set();
    visible.forEach(function (record) { if (record && record.dup) duplicateBadges.add(text(record.badge)); });
    counts.dups = duplicateBadges.size;
    counts.total = visible.length;
    counts.needsAction = visible.length - counts.matched;
    return Object.assign({}, snapshot, { counts: counts, records: visible });
  }

  function filterSchedule(user, schedule, context) {
    schedule = schedule && typeof schedule === 'object' ? schedule : {};
    var people = Array.isArray(schedule.people) ? schedule.people : null;
    if (!people || !hasRestriction(user)) {
      return people ? Object.assign({}, schedule, { people: people.slice() }) : Object.assign({}, schedule);
    }
    var visible = filterRecords(user, 'schedule', people, context);
    // A guessed period containing no authorized people must not reveal its file
    // name, execution timestamp, or even that a schedule was stored.
    return visible.length ? Object.assign({}, schedule, { people: visible }) : {};
  }

  function scopedCoverageSummary(exceptions, presentKeys) {
    var byStatus = {}, keys = new Set(presentKeys || []);
    (exceptions || []).forEach(function (row) {
      var status = text(row && row.status);
      if (status) byStatus[status] = (byStatus[status] || 0) + 1;
      var key = text(row && row.key);
      if (key) keys.add(key);
    });
    return {
      total: keys.size,
      present: (presentKeys || []).length,
      exceptions: (exceptions || []).length,
      byStatus: byStatus,
      // The persisted compact shape cannot reconstruct an authorized market's
      // on-shift denominator. Null is honest; the global percentage is a leak.
      coverage: null
    };
  }

  function filterCoverage(user, coverage, context) {
    coverage = coverage && typeof coverage === 'object' ? coverage : {};
    if (!hasRestriction(user)) {
      return Object.assign({}, coverage, {
        checks: Array.isArray(coverage.checks) ? coverage.checks.slice() : [],
        documented: coverage.documented && typeof coverage.documented === 'object'
          ? Object.assign({}, coverage.documented) : {}
      });
    }
    var compiled = compileContext(context), checks = [];
    (Array.isArray(coverage.checks) ? coverage.checks : []).forEach(function (check) {
      check = check || {};
      var exceptions = filterRecords(user, 'coverage', check.exceptions || [], compiled);
      var presentKeys = (Array.isArray(check.presentKeys) ? check.presentKeys : []).filter(function (key) {
        return recordDecision(user, 'coverage', { key: key }, compiled).allowed;
      });
      if (!exceptions.length && !presentKeys.length) return;
      /* The full report gets the SAME scoping as the exceptions. It arrives on
         the check only for days still inside the retention window, and it names
         every person on the floor -- so copying the check through with
         Object.assign and leaving this alone would hand a market-scoped account
         every other market's roster, by the widest margin of anything here. */
      var scoped = Object.assign({}, check, {
        exceptions: exceptions,
        presentKeys: presentKeys,
        summary: scopedCoverageSummary(exceptions, presentKeys)
      });
      if (Array.isArray(check.rows)) {
        scoped.rows = filterRecords(user, 'coverage', check.rows, compiled);
      }
      checks.push(scoped);
    });
    var documented = {};
    Object.keys(coverage.documented && typeof coverage.documented === 'object'
      ? coverage.documented : {}).forEach(function (key) {
      var record = Object.assign({ key: key }, coverage.documented[key] || {});
      if (recordDecision(user, 'coverage', record, compiled).allowed) documented[key] = coverage.documented[key];
    });
    if (!checks.length && !Object.keys(documented).length) return {};
    return Object.assign({}, coverage, { checks: checks, documented: documented });
  }

  function coverageCheckDecision(user, check, context) {
    if (!hasRestriction(user)) return { allowed: true, unrestricted: true };
    check = check || {};
    var compiled = compileContext(context), decisions = [];
    (Array.isArray(check.exceptions) ? check.exceptions : []).forEach(function (row) {
      decisions.push(recordDecision(user, 'coverage', row, compiled));
    });
    // Whatever is being STORED is what is being judged. The full report reaches
    // further than the exceptions do, so it is checked too.
    (Array.isArray(check.rows) ? check.rows : []).forEach(function (row) {
      decisions.push(recordDecision(user, 'coverage', row, compiled));
    });
    (Array.isArray(check.presentKeys) ? check.presentKeys : []).forEach(function (key) {
      decisions.push(recordDecision(user, 'coverage', { key: key }, compiled));
    });
    if (!decisions.length) return { allowed: false, reason: 'unassigned' };
    var denied = decisions.filter(function (decision) { return !decision.allowed; })[0];
    return denied || { allowed: true };
  }

  function scopedPayrollSummary(rows, changes) {
    var badges = new Set(), total = 0, added = 0, removed = 0, changed = 0, net = 0;
    (rows || []).forEach(function (row) {
      var badge = text(row && row.badge);
      if (badge) badges.add(badge);
      var hours = Number(row && row.hours);
      if (isFinite(hours)) total += hours;
    });
    (changes || []).forEach(function (change) {
      if (change && change.kind === 'added') added++;
      else if (change && change.kind === 'removed') removed++;
      else changed++;
      var delta = Number(change && change.delta);
      if (isFinite(delta)) net += delta;
    });
    function round2(value) { return Math.round(value * 100) / 100; }
    return { people: badges.size, totalHours: round2(total), added: added, removed: removed,
      changed: changed, net: round2(net), touched: (changes || []).length };
  }

  function filterPayroll(user, period, context) {
    period = period && typeof period === 'object' ? period : {};
    if (!hasRestriction(user)) {
      return Object.assign({}, period, {
        snapshots: Array.isArray(period.snapshots) ? period.snapshots.slice() : [],
        changes: Array.isArray(period.changes) ? period.changes.slice() : []
      });
    }
    var compiled = compileContext(context);
    var changes = filterRecords(user, 'payroll', period.changes || [], compiled);
    var snapshots = [];
    (Array.isArray(period.snapshots) ? period.snapshots : []).forEach(function (snapshot) {
      // Older snapshots intentionally discard their rows. Their aggregate is
      // global and cannot be partitioned after the fact, so restricted reads
      // omit them instead of exposing it or pretending it is local.
      if (!snapshot || !Array.isArray(snapshot.rows)) return;
      var rows = filterRecords(user, 'payroll', snapshot.rows, compiled);
      if (!rows.length) return;
      var at = text(snapshot.takenAt);
      var snapshotChanges = changes.filter(function (change) { return text(change && change.at) === at; });
      snapshots.push(Object.assign({}, snapshot, {
        rows: rows,
        summary: scopedPayrollSummary(rows, snapshotChanges)
      }));
    });
    if (!snapshots.length && !changes.length) return {};
    return Object.assign({}, period, { snapshots: snapshots, changes: changes });
  }

  return {
    normalizeMarket: normalizeMarket,
    hasRestriction: hasRestriction,
    allowedMarkets: function (user) { return Array.from(allowedMarkets(user)); },
    resolveRecordMarkets: resolveRecordMarkets,
    recordDecision: recordDecision,
    recordIdentity: recordIdentity,
    filterRecords: filterRecords,
    mergeRestrictedReplace: mergeRestrictedReplace,
    filterSnapshot: filterSnapshot,
    filterSchedule: filterSchedule,
    filterCoverage: filterCoverage,
    coverageCheckDecision: coverageCheckDecision,
    filterPayroll: filterPayroll
  };
}));
