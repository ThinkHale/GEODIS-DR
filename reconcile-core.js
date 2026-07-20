/*
 * reconcile-core.js
 * Shared badge-reconciliation logic for Badge Crosscheck.
 *
 * This file is the single source of truth for the matching and
 * recommendation rules. It is loaded two ways:
 *   1. In the browser, via <script src="reconcile-core.js">, exposing
 *      a global `ReconcileCore` object.
 *   2. In the Cloud Function, via require('./reconcile-core.js').
 *
 * It has no DOM or Node-specific dependencies -- it only operates on
 * plain data (arrays of arrays, as produced by SheetJS's
 * XLSX.utils.sheet_to_json(ws, {header:1})), so it behaves identically
 * in both environments. If the matching rules ever need to change,
 * change them here once.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ReconcileCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NAME_MATCH_THRESHOLD = 0.78;
  var CRM_STALE_DAYS = 90;
  var BEE_RECENT_DAYS = 7;

  var DETECT = {
    beeline: {
      badge:  [/^assignment id$/i, /assignment\s*id/i, /badge/i, /kronos/i, /\bid\b/i],
      name:   [/contractor name/i, /^name$/i, /full name/i, /name/i],
      status: [/assignment status/i, /status/i],
      pc:     [/profit center/i, /profit/i, /cost center/i],
      start:  [/current start date/i, /^start date$/i, /start\s*date/i, /^start$/i],
      end:    [/current end date/i, /^end date$/i, /end\s*date/i, /^end$/i]
    },
    crm: {
      badge:  [/^badge number$/i, /badge\s*number/i, /badge/i, /assignment id/i],
      name:   [/person placed name/i, /placed name/i, /^name$/i, /candidate/i, /name/i],
      status: [/assignment status/i, /status/i],
      pc:     [/profit center/i, /profit/i, /cost center/i],
      start:  [/^start date$/i, /start\s*date/i, /assignment start/i, /^start$/i],
      end:    [/^end date$/i, /end\s*date/i, /^end$/i]
    }
  };
  var HEADER_KEYWORDS = /badge|assignment id|contractor name|person placed|status|name|kronos|profit|start date|end date/i;

  var ACTIONS = {
    endCrm:      { label: 'End in CRM',       cls: 'act-dup' },
    addBeeline:  { label: 'Add to Beeline',   cls: 'act-bee' },
    addBadge:    { label: 'Add Badge in CRM', cls: 'act-info' },
    addCrm:      { label: 'Add to CRM',       cls: 'act-crm' },
    checkRegion: { label: 'Check Region',     cls: 'act-neutral' },
    matched:     { label: 'Matched',          cls: 'act-ok' }
  };
  var ACTION_ORDER = { endCrm: 0, addBeeline: 1, addBadge: 2, addCrm: 3, checkRegion: 4, matched: 5 };
  var ACTION_STAT_CARD = {
    endCrm:      { cls: 'dup',     k: 'End in CRM' },
    addBeeline:  { cls: 'bee',     k: 'Add to Beeline' },
    addBadge:    { cls: 'info',    k: 'Add Badge in CRM' },
    addCrm:      { cls: 'crm',     k: 'Add to CRM' },
    checkRegion: { cls: 'neutral', k: 'Check Region' }
  };

  /* ---------- header / column detection ---------- */
  function detectHeaderRow(aoa) {
    var limit = Math.min(25, aoa.length), best = 0, bestScore = -1;
    for (var r = 0; r < limit; r++) {
      var row = aoa[r] || [], filled = 0, kw = 0, strings = 0;
      row.forEach(function (c) {
        if (c !== null && String(c).trim() !== '') {
          filled++;
          if (typeof c === 'string') {
            strings++;
            if (HEADER_KEYWORDS.test(c)) kw++;
          }
        }
      });
      var score = kw * 10 + strings * 1.5 + filled * 0.5;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return best;
  }
  function pickCol(headers, patterns) {
    for (var i = 0; i < patterns.length; i++) {
      var idx = headers.findIndex(function (h) { return patterns[i].test(h); });
      if (idx !== -1) return idx;
    }
    return -1;
  }
  /* Build a full `st` state object from a parsed sheet (array-of-arrays) */
  function buildState(aoa, side, overrides) {
    var headerRow = detectHeaderRow(aoa);
    var headers = (aoa[headerRow] || []).map(function (h, i) {
      return (h == null || String(h).trim() === '') ? ('Column ' + (i + 1)) : String(h).trim();
    });
    var st = {
      aoa: aoa, headerRow: headerRow, headers: headers,
      activeOnly: true, selectedRegions: null
    };
    st.badgeCol  = pickCol(headers, DETECT[side].badge);
    st.nameCol   = pickCol(headers, DETECT[side].name);
    st.statusCol = pickCol(headers, DETECT[side].status);
    st.pcCol     = pickCol(headers, DETECT[side].pc);
    st.startCol  = pickCol(headers, DETECT[side].start);
    st.endCol    = pickCol(headers, DETECT[side].end);
    if (overrides) { for (var k in overrides) { if (overrides[k] !== undefined) st[k] = overrides[k]; } }
    return st;
  }

  /* ---------- normalize ---------- */
  function normBadge(v) {
    if (v == null) return '';
    var s = String(v).trim();
    if (s === '') return '';
    if (/^\d+\.0+$/.test(s)) s = s.split('.')[0];
    return s.replace(/,/g, '').replace(/\s+/g, '');
  }
  function isActive(v) { return v != null && String(v).trim().toLowerCase() === 'active'; }
  function regionOf(v) {
    if (v == null) return '';
    var s = String(v).trim();
    if (s === '') return '';
    var parts = s.split(';').map(function (x) { return x.trim(); });
    return parts.length >= 3 ? parts[2] : s;
  }
  function parseDateVal(v) {
    if (v == null) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') {
      if (!isFinite(v)) return null;
      var ms = Math.round((v - 25569) * 86400000);
      var d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }
    if (typeof v === 'string') {
      var s = v.trim();
      if (s === '') return null;
      var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
      if (m) {
        var mo = m[1], da = m[2], yr = m[3];
        yr = yr.length === 2 ? ('20' + yr) : yr;
        var d1 = new Date(Date.UTC(+yr, +mo - 1, +da));
        return isNaN(d1.getTime()) ? null : d1;
      }
      m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) {
        var d2 = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
        return isNaN(d2.getTime()) ? null : d2;
      }
      var d3 = new Date(s);
      return isNaN(d3.getTime()) ? null : d3;
    }
    return null;
  }
  function fmtDate(d) {
    if (!d) return '';
    return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + d.getUTCFullYear();
  }
  function daysAgo(d, now) {
    if (!d) return null;
    now = now || new Date();
    var todayUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    var dUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return Math.round((todayUTC - dUTC) / 86400000);
  }

  /* ---------- name matching ---------- */
  function levenshtein(a, b) {
    var al = a.length, bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    var dp = new Array(bl + 1);
    for (var j = 0; j <= bl; j++) dp[j] = j;
    for (var i = 1; i <= al; i++) {
      var prev = dp[0]; dp[0] = i;
      for (j = 1; j <= bl; j++) {
        var tmp = dp[j];
        dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
        prev = tmp;
      }
    }
    return dp[bl];
  }
  function normalizeNameForMatch(s) {
    if (!s) return '';
    var t = String(s).toLowerCase().replace(/[.,]/g, ' ').replace(/[^a-z\s]/g, ' ');
    var tokens = t.split(/\s+/).filter(Boolean).filter(function (tok) { return tok.length > 1; });
    tokens.sort();
    return tokens.join(' ');
  }
  function nameSimilarity(a, b) {
    var na = normalizeNameForMatch(a), nb = normalizeNameForMatch(b);
    if (na === '' || nb === '') return 0;
    var dist = levenshtein(na, nb);
    var maxLen = Math.max(na.length, nb.length);
    return maxLen === 0 ? 1 : 1 - dist / maxLen;
  }

  /* ---------- region helpers ---------- */
  function regionsFor(st) {
    if (!st || st.pcCol === -1) return [];
    var counts = new Map();
    st.aoa.slice(st.headerRow + 1).forEach(function (row) {
      if (!row) return;
      if (st.activeOnly && st.statusCol !== -1 && !isActive(row[st.statusCol])) return;
      if (normBadge(row[st.badgeCol]) === '') return;
      var reg = regionOf(row[st.pcCol]);
      if (reg === '') return;
      counts.set(reg, (counts.get(reg) || 0) + 1);
    });
    return Array.from(counts.entries()).map(function (e) { return { region: e[0], count: e[1] }; })
      .sort(function (a, b) { return b.count - a.count; });
  }
  function otherBadgeSet(otherSt) {
    var set = new Set();
    if (!otherSt) return set;
    otherSt.aoa.slice(otherSt.headerRow + 1).forEach(function (row) {
      if (!row) return;
      if (otherSt.activeOnly && otherSt.statusCol !== -1 && !isActive(row[otherSt.statusCol])) return;
      var b = normBadge(row[otherSt.badgeCol]);
      if (b !== '') set.add(b);
    });
    return set;
  }
  function regionsOverlapping(st, badgeSet) {
    var out = new Set();
    if (!st || st.pcCol === -1) return out;
    st.aoa.slice(st.headerRow + 1).forEach(function (row) {
      if (!row) return;
      if (st.activeOnly && st.statusCol !== -1 && !isActive(row[st.statusCol])) return;
      var b = normBadge(row[st.badgeCol]);
      if (b === '' || !badgeSet.has(b)) return;
      var reg = regionOf(row[st.pcCol]);
      if (reg !== '') out.add(reg);
    });
    return out;
  }
  /* Convenience: auto-select the Beeline regions that overlap the other file's badges */
  function autoSelectRegions(st, otherSt) {
    if (!st || st.pcCol === -1) return null;
    var overlap = otherSt ? regionsOverlapping(st, otherBadgeSet(otherSt)) : new Set();
    if (overlap.size > 0) return overlap;
    return new Set(regionsFor(st).map(function (r) { return r.region; }));
  }

  /* ---------- indexing ---------- */
  function indexSide(st) {
    var map = new Map(), dups = new Set();
    st.aoa.slice(st.headerRow + 1).forEach(function (row) {
      if (!row) return;
      var badge = normBadge(row[st.badgeCol]);
      if (badge === '') return;
      if (st.activeOnly && st.statusCol !== -1 && !isActive(row[st.statusCol])) return;
      var region = st.pcCol !== -1 ? regionOf(row[st.pcCol]) : '';
      if (st.pcCol !== -1 && st.selectedRegions && !st.selectedRegions.has(region)) return;
      var name = st.nameCol !== -1 && row[st.nameCol] != null ? String(row[st.nameCol]).trim() : '';
      var start = st.startCol !== -1 ? parseDateVal(row[st.startCol]) : null;
      if (map.has(badge)) { map.get(badge).count++; dups.add(badge); }
      else map.set(badge, { name: name, region: region, start: start, count: 1 });
    });
    return { map: map, dups: dups };
  }
  /* Full Beeline history, ignoring active/region filters */
  function buildFullBeelineLookup(st) {
    var map = new Map();
    if (!st) return map;
    st.aoa.slice(st.headerRow + 1).forEach(function (row) {
      if (!row) return;
      var badge = normBadge(row[st.badgeCol]);
      if (badge === '') return;
      var status = st.statusCol !== -1 && row[st.statusCol] != null ? String(row[st.statusCol]).trim() : '';
      var region = st.pcCol !== -1 ? regionOf(row[st.pcCol]) : '';
      var start = st.startCol !== -1 ? parseDateVal(row[st.startCol]) : null;
      var end = st.endCol !== -1 ? parseDateVal(row[st.endCol]) : null;
      var rec = { status: status, region: region, start: start, end: end };
      var existing = map.get(badge);
      if (!existing) map.set(badge, rec);
      else if (existing.status.toLowerCase() !== 'active' && status.toLowerCase() === 'active') map.set(badge, rec);
    });
    return map;
  }
  /* CRM rows with a name but no badge number */
  function collectUnbadgedCrm(st) {
    var rows = [], id = 0;
    if (!st) return rows;
    st.aoa.slice(st.headerRow + 1).forEach(function (row) {
      if (!row) return;
      var badge = st.badgeCol !== -1 ? normBadge(row[st.badgeCol]) : '';
      if (badge !== '') return;
      if (st.activeOnly && st.statusCol !== -1 && !isActive(row[st.statusCol])) return;
      var name = st.nameCol !== -1 && row[st.nameCol] != null ? String(row[st.nameCol]).trim() : '';
      if (name === '') return;
      rows.push({ id: id++, name: name });
    });
    return rows;
  }
  /* Greedy 1:1 name matching between unbadged CRM rows and Beeline-only records */
  function matchUnbadgedToOnlyBee(unbadgedRows, onlyBeeRecords, threshold) {
    threshold = threshold || NAME_MATCH_THRESHOLD;
    var pairs = [];
    unbadgedRows.forEach(function (u) {
      onlyBeeRecords.forEach(function (r) {
        var score = nameSimilarity(u.name, r.beeName);
        if (score >= threshold) pairs.push({ id: u.id, name: u.name, badge: r.badge, score: score });
      });
    });
    pairs.sort(function (a, b) { return b.score - a.score; });
    var usedCrm = new Set(), usedBadge = new Set(), result = new Map();
    pairs.forEach(function (p) {
      if (usedCrm.has(p.id) || usedBadge.has(p.badge)) return;
      usedCrm.add(p.id); usedBadge.add(p.badge);
      result.set(p.badge, { crmName: p.name, score: p.score });
    });
    return result;
  }

  /* ---------- top-level reconciliation ---------- */
  /* beeSt, crmSt: state objects built via buildState(), with selectedRegions
     already set on beeSt (use autoSelectRegions() if you don't have your own UI). */
  function reconcile(beeSt, crmSt) {
    var bi = indexSide(beeSt), ci = indexSide(crmSt);
    var all = new Set(Array.from(bi.map.keys()).concat(Array.from(ci.map.keys())));
    var records = [];
    all.forEach(function (badge) {
      var inBee = bi.map.has(badge), inCrm = ci.map.has(badge);
      var status = 'matched';
      if (inCrm && !inBee) status = 'onlyCrm'; else if (inBee && !inCrm) status = 'onlyBee';
      var region = (inBee && bi.map.get(badge).region) || (inCrm && ci.map.get(badge).region) || '';
      records.push({
        badge: badge,
        crmName: inCrm ? ci.map.get(badge).name : '',
        crmStart: inCrm ? ci.map.get(badge).start : null,
        beeName: inBee ? bi.map.get(badge).name : '',
        beeStart: inBee ? bi.map.get(badge).start : null,
        market: region,
        status: status,
        dup: bi.dups.has(badge) || ci.dups.has(badge)
      });
    });

    var beeFull = buildFullBeelineLookup(beeSt);
    var unbadgedCrm = collectUnbadgedCrm(crmSt);
    var onlyBeeRecords = records.filter(function (r) { return r.status === 'onlyBee'; });
    var nameMatches = matchUnbadgedToOnlyBee(unbadgedCrm, onlyBeeRecords, NAME_MATCH_THRESHOLD);
    var selRegions = beeSt.selectedRegions;

    records.forEach(function (r) {
      if (r.status === 'matched') {
        r.action = 'matched';
        r.reason = 'Badge is active in both systems.';
      } else if (r.status === 'onlyCrm') {
        var full = beeFull.get(r.badge);
        if (full && full.status && full.status.toLowerCase() !== 'active') {
          r.action = 'endCrm';
          r.reason = 'Beeline shows this assignment as ' + full.status +
            (full.end ? (' (ended ' + fmtDate(full.end) + ')') : (full.start ? (' (started ' + fmtDate(full.start) + ')') : '')) +
            '. Recommend ending it in CRM.';
        } else if (full && full.status && full.status.toLowerCase() === 'active' && beeSt.pcCol !== -1 && selRegions && !selRegions.has(full.region)) {
          r.action = 'checkRegion';
          r.reason = 'Active in Beeline under "' + full.region + '", outside the selected market(s). Confirm this is the right market or update CRM.';
        } else {
          r.action = 'addBeeline';
          r.reason = 'No record of this badge in Beeline (any status or market). Confirm still active and add to Beeline, or end in CRM if the placement ended.';
          var age1 = daysAgo(r.crmStart);
          if (age1 != null && age1 > CRM_STALE_DAYS) r.reason += ' CRM start date is ' + age1 + ' days old, worth verifying.';
        }
      } else { // onlyBee
        var m = nameMatches.get(r.badge);
        if (m) {
          r.action = 'addBadge';
          r.reason = 'Likely already in CRM as "' + m.crmName + '" with no badge on file (' + Math.round(m.score * 100) + '% name match). Suggested badge: ' + r.badge + '.';
        } else {
          r.action = 'addCrm';
          r.reason = 'Active in Beeline, no matching CRM record found by badge or name. Add as a new placement.';
          var age2 = daysAgo(r.beeStart);
          if (age2 != null && age2 <= BEE_RECENT_DAYS) r.reason += ' Recently started, may just be pending entry.';
        }
      }
      r.person = r.crmName || r.beeName;
      r.altName = (r.crmName && r.beeName && r.crmName !== r.beeName) ? r.beeName : '';
    });

    var counts = {};
    Object.keys(ACTIONS).forEach(function (k) { counts[k] = 0; });
    records.forEach(function (r) { counts[r.action]++; });
    counts.dups = new Set(records.filter(function (r) { return r.dup; }).map(function (r) { return r.badge; })).size;
    counts.total = records.length;
    counts.needsAction = records.length - counts.matched;

    return { records: records, counts: counts };
  }

  return {
    NAME_MATCH_THRESHOLD: NAME_MATCH_THRESHOLD,
    CRM_STALE_DAYS: CRM_STALE_DAYS,
    BEE_RECENT_DAYS: BEE_RECENT_DAYS,
    DETECT: DETECT,
    HEADER_KEYWORDS: HEADER_KEYWORDS,
    ACTIONS: ACTIONS,
    ACTION_ORDER: ACTION_ORDER,
    ACTION_STAT_CARD: ACTION_STAT_CARD,
    detectHeaderRow: detectHeaderRow,
    pickCol: pickCol,
    buildState: buildState,
    normBadge: normBadge,
    isActive: isActive,
    regionOf: regionOf,
    parseDateVal: parseDateVal,
    fmtDate: fmtDate,
    daysAgo: daysAgo,
    levenshtein: levenshtein,
    normalizeNameForMatch: normalizeNameForMatch,
    nameSimilarity: nameSimilarity,
    regionsFor: regionsFor,
    otherBadgeSet: otherBadgeSet,
    regionsOverlapping: regionsOverlapping,
    autoSelectRegions: autoSelectRegions,
    indexSide: indexSide,
    buildFullBeelineLookup: buildFullBeelineLookup,
    collectUnbadgedCrm: collectUnbadgedCrm,
    matchUnbadgedToOnlyBee: matchUnbadgedToOnlyBee,
    reconcile: reconcile
  };
});
