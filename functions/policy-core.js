/* GEODIS Management Suite -- verified attendance and performance policy.
 *
 * Policy-sensitive labels are decisions, not presentation defaults.  This core
 * resolves a verified policy for a market/site/date, exposes its provenance and
 * performs calculations only through that verified resolution.  When policy is
 * missing, invalid, unverified or outside scope, callers still receive the raw
 * facts but never an authoritative standing or composite score.
 */
(function (root) {
  'use strict';

  var POINT_TYPES = [
    'Present', 'Late', 'Early Out', 'Absent', 'No Call / No Show', 'Excused'
  ];
  var MISSING_RULES = ['require-all', 'renormalize'];
  var MAX_TEXT = 160;
  var CONTROL = /[\u0000-\u001f\u007f]/g;

  function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }
  function text(value, max) {
    return String(value == null ? '' : value).replace(CONTROL, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, max || MAX_TEXT).trim();
  }
  function finite(value) {
    var n = Number(value);
    return value !== '' && value != null && isFinite(n) ? n : null;
  }
  function uniqueList(value) {
    var rows = Array.isArray(value) ? value : (value == null || value === '' ? [] : String(value).split(','));
    var seen = {}, out = [];
    rows.forEach(function (item) {
      var clean = text(item, 100), key = clean.toLowerCase();
      if (!clean || seen[key]) return;
      seen[key] = true;
      out.push(clean);
    });
    return out;
  }
  function cloneObject(value) {
    var out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    Object.keys(value).forEach(function (key) { out[key] = value[key]; });
    return out;
  }
  function validDateParts(year, month, day) {
    var d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  }
  function dateOnly(value) {
    if (value instanceof Date) {
      if (isNaN(value.getTime())) return '';
      return value.toISOString().slice(0, 10);
    }
    var s = String(value == null ? '' : value).trim();
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      return validDateParts(+m[1], +m[2], +m[3]) ? m[1] + '-' + m[2] + '-' + m[3] : '';
    }
    if (!s) return '';
    var parsed = new Date(s);
    return isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
  }
  function atDate(context) {
    context = context || {};
    if (has(context, 'at') || has(context, 'date')) {
      return dateOnly(has(context, 'at') ? context.at : context.date);
    }
    return dateOnly(new Date());
  }

  function normalizePointValues(value) {
    var out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    Object.keys(value).forEach(function (key) {
      var clean = text(key, 100);
      if (clean) out[clean] = finite(value[key]);
    });
    return out;
  }
  function normalizeBands(value) {
    var out = (Array.isArray(value) ? value : []).map(function (row) {
      row = row || {};
      var rawMax = row.max;
      var max = rawMax == null || rawMax === '' || rawMax === '*' || rawMax === 'Infinity' || rawMax === Infinity
        ? Infinity : finite(rawMax);
      return {
        max: max,
        standing: text(row.standing || row.label, 120),
        cls: text(row.cls, 40)
      };
    });
    out.sort(function (a, b) {
      if (a.max === b.max) return 0;
      if (a.max === Infinity) return 1;
      if (b.max === Infinity) return -1;
      if (a.max == null) return 1;
      if (b.max == null) return -1;
      return a.max - b.max;
    });
    return out;
  }
  function normalizeWeights(value) {
    var out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    Object.keys(value).forEach(function (key) {
      var clean = text(key, 80);
      if (clean) out[clean] = finite(value[key]);
    });
    return out;
  }

  function normalizePolicy(input) {
    input = input || {};
    var precision = finite(input.performancePrecision);
    precision = precision == null ? 0 : Math.max(0, Math.min(3, Math.round(precision)));
    var missing = text(input.performanceMissing, 40) || 'require-all';
    return {
      id: text(input.id, 100),
      name: text(input.name, 160),
      version: text(input.version, 80),
      effectiveFrom: dateOnly(input.effectiveFrom),
      effectiveTo: input.effectiveTo ? dateOnly(input.effectiveTo) : '',
      markets: uniqueList(input.markets),
      sites: uniqueList(input.sites),
      verifiedAt: text(input.verifiedAt, 80),
      verifiedBy: text(input.verifiedBy, 120),
      pointValues: normalizePointValues(input.pointValues),
      bands: normalizeBands(input.bands),
      performanceWeights: normalizeWeights(input.performanceWeights),
      performanceMissing: missing,
      performancePrecision: precision
    };
  }

  /* Structural validity and verification are deliberately separate.  A complete
     draft may be valid configuration without yet being safe to use for people
     decisions; verifiedAt + verifiedBy are what cross that line. */
  function validatePolicy(input) {
    var policy = normalizePolicy(input);
    var errors = [], verificationErrors = [];
    if (!policy.id) errors.push('Policy id is required.');
    if (!policy.name) errors.push('Policy name is required.');
    if (!policy.version) errors.push('Policy version is required.');
    if (!policy.effectiveFrom) errors.push('A valid effective-from date is required.');
    if (input && input.effectiveTo && !policy.effectiveTo) errors.push('Effective-to date is invalid.');
    if (policy.effectiveFrom && policy.effectiveTo && policy.effectiveTo < policy.effectiveFrom) {
      errors.push('Effective-to date cannot precede effective-from date.');
    }

    POINT_TYPES.forEach(function (type) {
      if (!has(policy.pointValues, type) || policy.pointValues[type] == null) {
        errors.push('Point value is required for ' + type + '.');
      }
    });
    Object.keys(policy.pointValues).forEach(function (type) {
      var value = policy.pointValues[type];
      if (value == null || value < 0) errors.push('Point value for ' + type + ' must be a non-negative number.');
    });

    if (!policy.bands.length) errors.push('At least one attendance standing band is required.');
    policy.bands.forEach(function (band, index) {
      if (band.max == null || band.max < 0) errors.push('Band maximum must be a non-negative number or open-ended.');
      if (!band.standing) errors.push('Every attendance band needs a standing label.');
      if (index && policy.bands[index - 1].max >= band.max) {
        errors.push('Attendance band maximums must be unique and increasing.');
      }
      if (band.max === Infinity && index !== policy.bands.length - 1) {
        errors.push('Only the final attendance band may be open-ended.');
      }
    });
    if (policy.bands.length && policy.bands[policy.bands.length - 1].max !== Infinity) {
      errors.push('The final attendance band must be open-ended.');
    }

    var weightKeys = Object.keys(policy.performanceWeights), weightTotal = 0;
    if (!weightKeys.length) errors.push('At least one performance weight is required.');
    weightKeys.forEach(function (key) {
      var value = policy.performanceWeights[key];
      if (value == null || value < 0) errors.push('Performance weight for ' + key + ' must be non-negative.');
      else weightTotal += value;
    });
    if (weightKeys.length && !(weightTotal > 0)) errors.push('Performance weights must total more than zero.');
    if (MISSING_RULES.indexOf(policy.performanceMissing) === -1) {
      errors.push('Performance missing-data rule must be require-all or renormalize.');
    }

    if (!policy.verifiedAt || isNaN(Date.parse(policy.verifiedAt))) {
      verificationErrors.push('A valid verification time is required.');
    }
    if (!policy.verifiedBy) verificationErrors.push('The policy verifier is required.');

    return {
      valid: errors.length === 0,
      verified: errors.length === 0 && verificationErrors.length === 0,
      errors: errors,
      verificationErrors: verificationErrors,
      policy: policy
    };
  }

  function scopeLabel(policy) {
    var markets = policy.markets, sites = policy.sites;
    if (!markets.length && !sites.length) return 'All markets and sites';
    if (markets.length && sites.length) return markets.join(', ') + ' · Sites ' + sites.join(', ');
    if (markets.length) return markets.join(', ') + ' · All sites';
    return 'All markets · Sites ' + sites.join(', ');
  }
  function metadataFrom(validation) {
    var p = validation.policy;
    return {
      id: p.id,
      name: p.name,
      version: p.version,
      label: p.name + (p.version ? ' · v' + p.version : ''),
      effectiveFrom: p.effectiveFrom,
      effectiveTo: p.effectiveTo,
      markets: p.markets.slice(),
      sites: p.sites.slice(),
      scopeLabel: scopeLabel(p),
      verified: validation.verified,
      verifiedAt: p.verifiedAt,
      verifiedBy: p.verifiedBy,
      errors: validation.errors.concat(validation.verificationErrors)
    };
  }
  function policyMetadata(input) {
    return metadataFrom(validatePolicy(input));
  }

  function scopeKey(value) { return text(value, 100).toLowerCase(); }
  function listHas(list, value) {
    var key = scopeKey(value);
    return !!key && list.some(function (item) { return scopeKey(item) === key; });
  }
  function scopeMatches(input, context) {
    var p = normalizePolicy(input), c = context || {};
    if (p.markets.length && !listHas(p.markets, c.market)) return false;
    if (p.sites.length && !listHas(p.sites, c.site)) return false;
    return true;
  }
  function isEffective(input, context) {
    var p = normalizePolicy(input), at = atDate(context);
    if (!at || !p.effectiveFrom || at < p.effectiveFrom) return false;
    return !p.effectiveTo || at <= p.effectiveTo;
  }
  function policyApplies(input, context) {
    var checked = validatePolicy(input);
    return checked.verified && scopeMatches(checked.policy, context) && isEffective(checked.policy, context);
  }
  function specificity(policy) {
    return (policy.markets.length ? 1 : 0) + (policy.sites.length ? 2 : 0);
  }

  var REASONS = {
    'missing-policy': 'No policy is configured for this decision.',
    'invalid-policy': 'The configured policy is incomplete or invalid.',
    'unverified-policy': 'The matching policy has not been verified.',
    'out-of-scope': 'No verified policy covers this market and site.',
    'not-effective': 'No verified policy is effective on this date.',
    'ambiguous-policy': 'More than one equally specific verified policy applies.',
    'unmapped-attendance-type': 'This attendance type is not mapped by the verified policy.',
    'invalid-points': 'Attendance points are missing or invalid.',
    'missing-performance-metric': 'The verified formula requires a performance metric that is missing.',
    'no-performance-facts': 'No numeric performance facts are available.'
  };
  function reasonFor(code) { return REASONS[code] || REASONS['unverified-policy']; }
  function contextSummary(context, at) {
    context = context || {};
    return { market: text(context.market, 100), site: text(context.site, 100), at: at || atDate(context) };
  }
  function unresolved(code, context, at) {
    return {
      authoritative: false,
      verified: false,
      code: code,
      reason: reasonFor(code),
      context: contextSummary(context, at),
      policy: null,
      metadata: null
    };
  }

  function resolvePolicy(policies, context) {
    var list = Array.isArray(policies) ? policies : (policies ? [policies] : []);
    var at = atDate(context);
    if (!list.length) return unresolved('missing-policy', context, at);

    var checked = list.map(validatePolicy);
    var valid = checked.filter(function (row) { return row.valid; });
    if (!valid.length) return unresolved('invalid-policy', context, at);

    var matching = valid.filter(function (row) {
      return scopeMatches(row.policy, context) && isEffective(row.policy, { at: at });
    });
    var candidates = matching.filter(function (row) { return row.verified; });
    if (!candidates.length) {
      if (matching.length) return unresolved('unverified-policy', context, at);
      var verified = valid.filter(function (row) { return row.verified; });
      if (!verified.length) return unresolved('unverified-policy', context, at);
      var scoped = verified.filter(function (row) { return scopeMatches(row.policy, context); });
      return unresolved(scoped.length ? 'not-effective' : 'out-of-scope', context, at);
    }

    candidates.sort(function (a, b) {
      var scope = specificity(b.policy) - specificity(a.policy);
      if (scope) return scope;
      return String(b.policy.effectiveFrom).localeCompare(String(a.policy.effectiveFrom));
    });
    var top = candidates[0], next = candidates[1];
    if (next && specificity(top.policy) === specificity(next.policy) &&
        top.policy.effectiveFrom === next.policy.effectiveFrom && top.policy.id !== next.policy.id) {
      return unresolved('ambiguous-policy', context, at);
    }

    return {
      authoritative: true,
      verified: true,
      code: 'verified',
      reason: '',
      context: contextSummary(context, at),
      policy: top.policy,
      metadata: metadataFrom(top)
    };
  }

  function usable(resolution) {
    return !!(resolution && resolution.authoritative === true && resolution.verified === true &&
      resolution.policy && resolution.metadata && resolution.metadata.verified === true);
  }
  function resultBase(resolution) {
    var ok = usable(resolution);
    var code = ok ? 'verified' : (resolution && resolution.code) || 'unverified-policy';
    return {
      policyVerified: ok,
      policyMetadata: ok ? resolution.metadata : null,
      code: code,
      reason: ok ? '' : (resolution && resolution.reason) || reasonFor(code)
    };
  }
  function pointLookup(type, resolution) {
    if (!usable(resolution)) return null;
    var values = resolution.policy.pointValues, wanted = text(type, 100).toLowerCase();
    var key = Object.keys(values).filter(function (candidate) {
      return candidate.toLowerCase() === wanted;
    })[0];
    return key && values[key] != null ? { type: key, points: values[key] } : null;
  }
  function pointValue(type, resolution) {
    var hit = pointLookup(type, resolution);
    return hit ? hit.points : null;
  }

  function evaluateAttendance(fact, resolution) {
    var raw = typeof fact === 'string' ? { type: fact } : cloneObject(fact);
    var type = text(raw.type, 100), rawPoints = finite(raw.points);
    var base = resultBase(resolution), hit = pointLookup(type, resolution);
    if (!hit) {
      var code = base.policyVerified ? 'unmapped-attendance-type' : base.code;
      return {
        raw: raw, type: type, rawPoints: rawPoints, points: null,
        authoritative: false, policyVerified: base.policyVerified,
        policyMetadata: base.policyMetadata, code: code,
        reason: base.policyVerified ? reasonFor(code) : base.reason
      };
    }
    return {
      raw: raw, type: hit.type, rawPoints: rawPoints, points: hit.points,
      authoritative: true, policyVerified: true,
      policyMetadata: base.policyMetadata, code: 'verified', reason: ''
    };
  }

  function bandFor(points, resolution) {
    var rawPoints = finite(points), base = resultBase(resolution);
    if (!base.policyVerified || rawPoints == null) {
      var code = rawPoints == null ? 'invalid-points' : base.code;
      return {
        rawPoints: rawPoints, standing: null, cls: '', max: null, openEnded: false,
        authoritative: false, policyVerified: base.policyVerified,
        policyMetadata: base.policyMetadata, code: code,
        reason: rawPoints == null ? reasonFor(code) : base.reason
      };
    }
    var bands = resolution.policy.bands, band = null;
    for (var i = 0; i < bands.length; i++) {
      if (rawPoints <= bands[i].max) { band = bands[i]; break; }
    }
    if (!band) {
      return {
        rawPoints: rawPoints, standing: null, cls: '', max: null, openEnded: false,
        authoritative: false, policyVerified: true, policyMetadata: base.policyMetadata,
        code: 'invalid-policy', reason: reasonFor('invalid-policy')
      };
    }
    return {
      rawPoints: rawPoints, standing: band.standing, cls: band.cls,
      max: band.max === Infinity ? null : band.max, openEnded: band.max === Infinity,
      authoritative: true, policyVerified: true, policyMetadata: base.policyMetadata,
      code: 'verified', reason: ''
    };
  }

  function attendanceSummary(facts, resolution) {
    var evaluations = (Array.isArray(facts) ? facts : []).map(function (fact) {
      return evaluateAttendance(fact, resolution);
    });
    var rawTotal = 0, hasRaw = false;
    evaluations.forEach(function (row) {
      if (row.rawPoints != null) { rawTotal += row.rawPoints; hasRaw = true; }
    });
    var allMapped = usable(resolution) && evaluations.every(function (row) { return row.authoritative; });
    var total = allMapped ? evaluations.reduce(function (sum, row) { return sum + row.points; }, 0) : null;
    var standing = bandFor(total, resolution);
    return {
      rawFacts: evaluations.map(function (row) { return row.raw; }),
      rawTotal: hasRaw ? rawTotal : null,
      evaluations: evaluations,
      points: total,
      standing: standing.standing,
      standingClass: standing.cls,
      authoritative: allMapped && standing.authoritative,
      policyVerified: usable(resolution),
      policyMetadata: usable(resolution) ? resolution.metadata : null,
      code: allMapped ? standing.code : (evaluations.filter(function (row) { return !row.authoritative; })[0] ||
        resultBase(resolution)).code,
      reason: allMapped ? standing.reason : (evaluations.filter(function (row) { return !row.authoritative; })[0] ||
        resultBase(resolution)).reason
    };
  }

  function weightFractions(policy) {
    var weights = policy.performanceWeights, sum = 0, out = {};
    Object.keys(weights).forEach(function (key) {
      if (weights[key] > 0) sum += weights[key];
    });
    if (!(sum > 0)) return null;
    Object.keys(weights).forEach(function (key) {
      if (weights[key] > 0) out[key] = weights[key] / sum;
    });
    return out;
  }
  function performanceWeights(resolution) {
    return usable(resolution) ? weightFractions(resolution.policy) : null;
  }
  function roundTo(value, places) {
    var scale = Math.pow(10, places || 0);
    var epsilon = Number.EPSILON || 2.220446049250313e-16;
    return Math.round((value + epsilon) * scale) / scale;
  }
  function performanceComposite(metrics, resolution) {
    var raw = cloneObject(metrics), numeric = {};
    Object.keys(raw).forEach(function (key) {
      var value = finite(raw[key]);
      if (value != null) numeric[key] = value;
    });
    var base = resultBase(resolution);
    if (!base.policyVerified) {
      return {
        raw: raw, metrics: numeric, score: null, weights: null, components: [],
        authoritative: false, policyVerified: false, policyMetadata: null,
        code: base.code, reason: base.reason
      };
    }
    var weights = weightFractions(resolution.policy), keys = Object.keys(weights || {});
    var present = keys.filter(function (key) { return has(numeric, key); });
    if (!present.length) {
      return {
        raw: raw, metrics: numeric, score: null, weights: weights, components: [],
        authoritative: false, policyVerified: true, policyMetadata: base.policyMetadata,
        code: 'no-performance-facts', reason: reasonFor('no-performance-facts')
      };
    }
    if (resolution.policy.performanceMissing === 'require-all' && present.length !== keys.length) {
      return {
        raw: raw, metrics: numeric, score: null, weights: weights, components: [],
        missing: keys.filter(function (key) { return !has(numeric, key); }),
        authoritative: false, policyVerified: true, policyMetadata: base.policyMetadata,
        code: 'missing-performance-metric', reason: reasonFor('missing-performance-metric')
      };
    }
    var appliedTotal = present.reduce(function (sum, key) { return sum + weights[key]; }, 0);
    var components = present.map(function (key) {
      var applied = weights[key] / appliedTotal;
      return {
        key: key, value: numeric[key], configuredWeight: weights[key],
        appliedWeight: applied, contribution: numeric[key] * applied
      };
    });
    var score = components.reduce(function (sum, row) { return sum + row.contribution; }, 0);
    return {
      raw: raw, metrics: numeric,
      score: roundTo(score, resolution.policy.performancePrecision),
      weights: weights, components: components, missing: [],
      authoritative: true, policyVerified: true, policyMetadata: base.policyMetadata,
      code: 'verified', reason: ''
    };
  }

  var api = {
    POINT_TYPES: POINT_TYPES.slice(),
    MISSING_RULES: MISSING_RULES.slice(),
    normalizePolicy: normalizePolicy,
    validatePolicy: validatePolicy,
    policyMetadata: policyMetadata,
    scopeMatches: scopeMatches,
    isEffective: isEffective,
    policyApplies: policyApplies,
    resolvePolicy: resolvePolicy,
    reasonFor: reasonFor,
    pointValue: pointValue,
    evaluateAttendance: evaluateAttendance,
    bandFor: bandFor,
    attendanceSummary: attendanceSummary,
    performanceWeights: performanceWeights,
    performanceComposite: performanceComposite
  };

  root.PolicyCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
