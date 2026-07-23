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
      end:    [/current end date/i, /^end date$/i, /end\s*date/i, /^end$/i],
      account: [],
      endReason: []
    },
    crm: {
      badge:  [/^badge number$/i, /badge\s*number/i, /badge/i, /assignment id/i],
      name:   [/person placed name/i, /placed name/i, /^name$/i, /candidate/i, /name/i],
      status: [/assignment status/i, /status/i],
      pc:     [/profit center/i, /profit/i, /cost center/i],
      start:  [/^start date$/i, /start\s*date/i, /assignment start/i, /^start$/i],
      end:    [/actual end date/i, /^end date$/i, /end\s*date/i, /^end$/i],
      // CRM has no clean market column; the market is inferred from the location
      // embedded in the Account path (see parseCrmAccount / learnCityMarkets).
      account: [/^account$/i, /^account name$/i, /\baccount\b/i],
      // Only present on the RC "Ended Assignments" report (identical to the active
      // report plus Actual End Date + End Reason).
      endReason: [/end reason/i, /termination reason/i, /^reason$/i],
      // RC person-level id, shown as the "Employee #" column.
      emp: [/legacy contact id/i, /contact id/i, /employee number/i, /employee\s*#/i, /associate number/i]
    }
  };
  // Locations with no active Beeline presence to learn a market from, but which are
  // their own markets. Keyed by cityKey (lowercased, alphanumerics only).
  var MARKET_OVERRIDES = {
    longbeachca: 'Long Beach CA',
    fortworthtx: 'Fort Worth TX'
  };
  var HEADER_KEYWORDS = /badge|assignment id|contractor name|person placed|status|name|kronos|profit|start date|end date|end reason/i;

  var ACTIONS = {
    endCrm:      { label: 'End in RC',          cls: 'act-dup' },
    endBeeline:  { label: 'End in Beeline',      cls: 'act-endb' },
    updateBadge: { label: 'Update Badge in RC', cls: 'act-upd' },
    addBeeline:  { label: 'Add to Beeline',      cls: 'act-bee' },
    addBadge:    { label: 'Add Badge in RC',    cls: 'act-info' },
    addCrm:      { label: 'Beeline Active / No RC Data', cls: 'act-crm' },
    checkRegion: { label: 'Check Region',        cls: 'act-neutral' },
    matched:     { label: 'Matched',             cls: 'act-ok' }
  };
  var ACTION_ORDER = { endCrm: 0, endBeeline: 1, updateBadge: 2, addBeeline: 3, addBadge: 4, addCrm: 5, checkRegion: 6, matched: 7 };
  var ACTION_STAT_CARD = {
    endCrm:      { cls: 'dup',     k: 'End in RC' },
    endBeeline:  { cls: 'endb',    k: 'End in Beeline' },
    updateBadge: { cls: 'upd',     k: 'Update Badge in RC' },
    addBeeline:  { cls: 'bee',     k: 'Add to Beeline' },
    addBadge:    { cls: 'info',    k: 'Add Badge in RC' },
    addCrm:      { cls: 'crm',     k: 'Beeline Active / No RC Data' },
    checkRegion: { cls: 'neutral', k: 'Check Region' }
  };

  // Confidence rule for treating an "End in RC" row and an active Beeline row as
  // the SAME person under a re-issued badge (rehire / reassignment).
  var BADGE_CHANGE_NAME_THRESHOLD = 0.90;

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
    st.accountCol = pickCol(headers, DETECT[side].account || []);
    st.endReasonCol = pickCol(headers, DETECT[side].endReason || []);
    st.empCol = pickCol(headers, DETECT[side].emp || []);
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
  /* The RC "Account" path embeds the physical location, e.g.
     "GEODIS/Beeline/1101 Taylor/Romeoville, IL/1502" -> facility "1101 Taylor",
     city "Romeoville, IL". The city (not the facility) is the reliable market key
     -- facility labels like "Multi"/"Post2" repeat across markets, whereas a city
     belongs to exactly one market. cityKey strips punctuation/case so
     "Wilmington, IL" and "WilmingtonIL" collapse to the same key. */
  function parseCrmAccount(v) {
    if (v == null) return { facility: '', city: '', cityKey: '' };
    var parts = String(v).split('/').map(function (x) { return x.trim(); });
    var facility = parts.length >= 3 ? parts[2] : '';
    var city = parts.length >= 4 ? parts[3] : (parts.length ? parts[parts.length - 1] : '');
    var cityKey = city.toLowerCase().replace(/[^a-z0-9]/g, '');
    return { facility: facility, city: city, cityKey: cityKey };
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

  /* ---------- badge-change (rehire) detection ---------- */
  function sameDay(a, b) {
    if (!a || !b) return false;
    return a.getUTCFullYear() === b.getUTCFullYear() &&
           a.getUTCMonth() === b.getUTCMonth() &&
           a.getUTCDate() === b.getUTCDate();
  }
  /* A name match alone isn't enough to merge two different badges; require a
     second signal that it's the same placement: same market, or the CRM
     assignment starting on the same day as the new Beeline assignment. */
  function badgeChangeCorroborated(crmRec, beeRec) {
    var rc = (crmRec.market || '').trim().toLowerCase();
    var rb = (beeRec.market || '').trim().toLowerCase();
    if (rc && rb && rc === rb) return true;
    if (sameDay(crmRec.crmStart, beeRec.beeStart)) return true;
    return false;
  }
  /* Greedy 1:1 pairing of onlyCrm records (CRM has an outdated badge) to active
     onlyBee records (same person under a new badge). Returns [{crm, bee, score}]. */
  function matchBadgeChanges(crmRecs, beeRecs, threshold) {
    threshold = threshold || BADGE_CHANGE_NAME_THRESHOLD;
    var pairs = [];
    crmRecs.forEach(function (c) {
      beeRecs.forEach(function (b) {
        if (c.badge === b.badge) return;
        var score = nameSimilarity(c.crmName, b.beeName);
        if (score >= threshold && badgeChangeCorroborated(c, b)) {
          pairs.push({ crm: c, bee: b, score: score });
        }
      });
    });
    pairs.sort(function (a, b) { return b.score - a.score; });
    var usedCrm = {}, usedBee = {}, result = [];
    pairs.forEach(function (p) {
      if (usedCrm[p.crm.badge] || usedBee[p.bee.badge]) return;
      usedCrm[p.crm.badge] = 1; usedBee[p.bee.badge] = 1;
      result.push(p);
    });
    return result;
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
      var acct = st.accountCol !== -1 ? parseCrmAccount(row[st.accountCol]) : null;
      var emp = st.empCol !== -1 && row[st.empCol] != null ? String(row[st.empCol]).trim() : '';
      if (map.has(badge)) { map.get(badge).count++; dups.add(badge); }
      else map.set(badge, {
        name: name, region: region, start: start, count: 1,
        city: acct ? acct.city : '', cityKey: acct ? acct.cityKey : '', emp: emp
      });
    });
    return { map: map, dups: dups };
  }
  /* Learn cityKey -> Beeline market from badges present in BOTH systems, so RC-only
     rows (which carry no market) can be labeled with the same market names Beeline
     uses. Majority vote per city tolerates the odd mis-tagged row. */
  function learnCityMarkets(crmSt, beeFull) {
    var tally = {};
    if (!crmSt || crmSt.accountCol === -1 || crmSt.badgeCol === -1) return {};
    crmSt.aoa.slice(crmSt.headerRow + 1).forEach(function (row) {
      if (!row) return;
      var badge = normBadge(row[crmSt.badgeCol]);
      if (badge === '') return;
      var acct = parseCrmAccount(row[crmSt.accountCol]);
      if (!acct.cityKey) return;
      var bee = beeFull.get(badge);
      if (!bee || !bee.region) return;
      (tally[acct.cityKey] = tally[acct.cityKey] || {})[bee.region] =
        (tally[acct.cityKey][bee.region] || 0) + 1;
    });
    var map = {};
    Object.keys(tally).forEach(function (ck) {
      var best = '', bestN = -1;
      Object.keys(tally[ck]).forEach(function (m) {
        if (tally[ck][m] > bestN) { bestN = tally[ck][m]; best = m; }
      });
      map[ck] = best;
    });
    return map;
  }
  /* Index the optional RC "Ended Assignments" report (people ended in RC within
     whatever window the report is generated for -- 30, 90 days, etc.) by badge and
     by normalized name, keeping the most recent end per person. Used to reclassify
     "Beeline Active / No RC Data" rows to "End in Beeline" when the person was
     recently terminated in RC. */
  function buildEndedIndex(endedSt) {
    var byBadge = {}, byName = {};
    if (!endedSt || endedSt.badgeCol === -1) return { byBadge: byBadge, byName: byName, has: false };
    endedSt.aoa.slice(endedSt.headerRow + 1).forEach(function (row) {
      if (!row) return;
      var badge = normBadge(row[endedSt.badgeCol]);
      var name = endedSt.nameCol !== -1 && row[endedSt.nameCol] != null ? String(row[endedSt.nameCol]).trim() : '';
      var end = endedSt.endCol !== -1 ? parseDateVal(row[endedSt.endCol]) : null;
      var reason = endedSt.endReasonCol !== -1 && row[endedSt.endReasonCol] != null ? String(row[endedSt.endReasonCol]).trim() : '';
      var emp = endedSt.empCol !== -1 && row[endedSt.empCol] != null ? String(row[endedSt.empCol]).trim() : '';
      var rec = { endDate: end, endReason: reason, name: name, emp: emp };
      var newer = function (existing) {
        return !existing || (end && (!existing.endDate || end > existing.endDate));
      };
      if (badge && newer(byBadge[badge])) byBadge[badge] = rec;
      var nk = normalizeNameForMatch(name);
      if (nk && newer(byName[nk])) byName[nk] = rec;
    });
    return { byBadge: byBadge, byName: byName, has: true };
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
  function reconcile(beeSt, crmSt, endedSt) {
    var bi = indexSide(beeSt), ci = indexSide(crmSt);
    var beeFull = buildFullBeelineLookup(beeSt);
    // Map each RC location to the Beeline market name, learned from shared badges.
    var cityMarkets = learnCityMarkets(crmSt, beeFull);
    var endedIndex = buildEndedIndex(endedSt);   // optional RC "Ended" report
    var all = new Set(Array.from(bi.map.keys()).concat(Array.from(ci.map.keys())));
    var records = [];
    all.forEach(function (badge) {
      var inBee = bi.map.has(badge), inCrm = ci.map.has(badge);
      var status = 'matched';
      if (inCrm && !inBee) status = 'onlyCrm'; else if (inBee && !inCrm) status = 'onlyBee';
      // Market: Beeline is authoritative when the badge is active there; otherwise
      // infer it from the RC account location. Locations we can't learn a market
      // for (no active Beeline worker there) go into a single "Other" bucket, with
      // the raw location kept in marketRaw so they can be triaged later.
      var crmRec = inCrm ? ci.map.get(badge) : null;
      var market, marketVerified, marketRaw = '';
      if (inBee) {
        market = bi.map.get(badge).region;
        marketVerified = true;
      } else {
        var ck = crmRec ? crmRec.cityKey : '';
        var learned = cityMarkets[ck] || MARKET_OVERRIDES[ck] || '';
        marketVerified = !!learned;
        market = learned || 'Other';
        if (!learned && crmRec) marketRaw = crmRec.city;
      }
      records.push({
        badge: badge,
        empNumber: crmRec ? (crmRec.emp || '') : '',
        crmName: inCrm ? ci.map.get(badge).name : '',
        crmStart: inCrm ? ci.map.get(badge).start : null,
        beeName: inBee ? bi.map.get(badge).name : '',
        beeStart: inBee ? bi.map.get(badge).start : null,
        market: market,
        marketVerified: marketVerified,
        marketRaw: marketRaw,
        status: status,
        endDate: null,
        endReason: '',
        dup: bi.dups.has(badge) || ci.dups.has(badge)
      });
    });

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
            '. Recommend ending it in RC.';
        } else if (full && full.status && full.status.toLowerCase() === 'active' && beeSt.pcCol !== -1 && selRegions && !selRegions.has(full.region)) {
          r.action = 'checkRegion';
          r.reason = 'Active in Beeline under "' + full.region + '", outside the selected market(s). Confirm this is the right market or update RC.';
        } else {
          r.action = 'addBeeline';
          r.reason = 'No record of this badge in Beeline (any status or market). Confirm still active and add to Beeline, or end in RC if the placement ended.';
          var age1 = daysAgo(r.crmStart);
          if (age1 != null && age1 > CRM_STALE_DAYS) r.reason += ' RC start date is ' + age1 + ' days old, worth verifying.';
        }
      } else { // onlyBee
        var m = nameMatches.get(r.badge);
        if (m) {
          r.action = 'addBadge';
          r.reason = 'Likely already in RC as "' + m.crmName + '" with no badge on file (' + Math.round(m.score * 100) + '% name match). Suggested badge: ' + r.badge + '.';
        } else {
          r.action = 'addCrm';
          r.reason = 'Active in Beeline, but not in the RC active-assignment export. Because RC only lists active assignments, this is either a new placement to add to RC, or an assignment that has already ended in RC and should be ended in Beeline. Verify in RC.';
          var age2 = daysAgo(r.beeStart);
          if (age2 != null && age2 <= BEE_RECENT_DAYS) r.reason += ' Started recently, so it may just be pending entry in RC.';
        }
      }
      r.person = r.crmName || r.beeName;
      r.altName = (r.crmName && r.beeName && r.crmName !== r.beeName) ? r.beeName : '';
    });

    /* Badge-change / rehire detection: a person whose CRM badge looks like it
       should be ended, but who is actually active in Beeline under a NEW badge.
       Collapse the two false rows (endCrm + addCrm) into one "Update Badge" row. */
    var onlyCrmRecs = records.filter(function (r) { return r.status === 'onlyCrm'; });
    var onlyBeeActive = records.filter(function (r) { return r.status === 'onlyBee'; });
    var badgeChanges = matchBadgeChanges(onlyCrmRecs, onlyBeeActive, BADGE_CHANGE_NAME_THRESHOLD);
    var mergedBeeBadges = {};
    badgeChanges.forEach(function (p) {
      var c = p.crm, b = p.bee, oldFull = beeFull.get(c.badge);
      c.action = 'updateBadge';
      c.newBadge = b.badge;
      if (!c.market && b.market) c.market = b.market; // show the new assignment's region
      c.reason = 'Active in Beeline under badge ' + b.badge +
        (b.market ? (' (' + b.market + ')') : '') +
        (b.beeStart ? (', started ' + fmtDate(b.beeStart)) : '') +
        ', but RC still has badge ' + c.badge +
        (oldFull && oldFull.end ? (' which expired in Beeline ' + fmtDate(oldFull.end)) : '') +
        '. Same person (' + Math.round(p.score * 100) + '% name match) — update the badge in RC from ' +
        c.badge + ' to ' + b.badge + '.';
      mergedBeeBadges[b.badge] = 1;
    });
    if (badgeChanges.length) {
      records = records.filter(function (r) {
        return !(r.status === 'onlyBee' && mergedBeeBadges[r.badge]);
      });
    }

    /* Ended-report cross-reference: a "Beeline Active / No RC Data" person who
       appears in the RC "Ended" report was recently terminated in RC, so the real
       action is to END them in Beeline. Match by badge first, then exact name. */
    if (endedIndex.has) {
      records.forEach(function (r) {
        if (r.action !== 'addCrm') return;
        var hit = endedIndex.byBadge[r.badge], via = 'badge';
        if (!hit) {
          var nk = normalizeNameForMatch(r.person || r.beeName);
          if (nk && endedIndex.byName[nk]) { hit = endedIndex.byName[nk]; via = 'name'; }
        }
        if (!hit) return;
        r.action = 'endBeeline';
        r.endDate = hit.endDate;
        r.endReason = hit.endReason;
        if (!r.empNumber && hit.emp) r.empNumber = hit.emp;
        r.reason = 'Active in Beeline, but ended in RC' +
          (hit.endDate ? (' on ' + fmtDate(hit.endDate)) : '') +
          (hit.endReason ? (' (reason: ' + hit.endReason + ')') : '') +
          '. Recommend ending it in Beeline.' +
          (via === 'name' ? ' (matched by name)' : '');
      });
    }

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
    BADGE_CHANGE_NAME_THRESHOLD: BADGE_CHANGE_NAME_THRESHOLD,
    matchBadgeChanges: matchBadgeChanges,
    parseCrmAccount: parseCrmAccount,
    learnCityMarkets: learnCityMarkets,
    buildEndedIndex: buildEndedIndex,
    MARKET_OVERRIDES: MARKET_OVERRIDES,
    reconcile: reconcile
  };
});
