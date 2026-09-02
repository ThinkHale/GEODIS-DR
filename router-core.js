/* GEODIS Management Suite -- shareable route and filter state.
 *
 * The suite has several views, two sets of sub-tabs and a growing set of useful
 * filters.  This module owns the URL vocabulary so browser history, bookmarks
 * and copied links can all use the same, deliberately small set of parameters.
 *
 * It has no DOM dependency.  Parsing never returns unknown parameters and
 * serialization always returns a query string only -- a URL hash is neither
 * consumed as route state nor copied into the result.
 */
(function (root) {
  'use strict';

  var VIEWS = [
    'overview', 'tasks', 'associates', 'profile', 'coverage', 'attendance',
    'timeoff', 'payroll', 'requisitions', 'reconciliation', 'settings'
  ];

  /* Tabs are route-specific.  A valid Settings tab must not accidentally become
     a valid Payroll tab just because both happen to use a `tab` parameter. */
  var TABS = {
    settings: ['account', 'users', 'connections', 'locations', 'shifts', 'links'],
    payroll: ['discrepancies', 'hours']
  };

  /* These are the only query-string names the parser consumes.  `query` is a
     tolerated input alias for older/copied links; new links always use compact
     `q`. */
  var PARAMS = [
    'view', 'badge', 'tab', 'market', 'q', 'status', 'source', 'filter',
    'kind', 'urgency', 'showDone', 'site', 'when', 'health',
    'coverageStatus', 'location', 'reviewDate', 'reviewId'
  ];
  var FILTER_KEYS = [
    'status', 'source', 'filter', 'kind', 'urgency', 'showDone', 'site',
    'when', 'health', 'coverageStatus', 'location', 'reviewDate', 'reviewId'
  ];

  var DEFAULTS = { view: 'overview', market: 'all' };
  var MAX_QUERY = 200;
  var MAX_VALUE = 100;
  var CONTROL = /[\u0000-\u001f\u007f]/g;
  /* Enum-like values may contain ordinary human punctuation (for example
     "St. Louis" and "No Call / No Show"), but never markup, a fragment marker,
     a query delimiter or a slash escaping character. */
  var UNSAFE_VALUE = /[<>{}`"\\?#=]/;
  var BADGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

  var BUILT_IN = {
    urgency: ['all', 'urgent', 'due', 'ok'],
    when: ['all', 'overdue', 'past', 'week', 'month', 'later', 'none'],
    health: ['all', 'short', 'empty', 'submitted', 'partial', 'filled'],
    coverageStatus: [
      'all', 'exceptions', 'onclock', 'onshift', 'missing', 'unscheduled',
      'notInReport', 'lingering', 'working', 'starting', 'early', 'scheduled',
      'complete', 'pto', 'off'
    ]
  };

  var OPTION_LIST = {
    market: 'markets',
    status: 'statuses',
    source: 'sources',
    filter: 'filters',
    kind: 'kinds',
    site: 'sites',
    location: 'locations',
    reviewId: 'reviewIds'
  };

  function copyArray(list) { return list.slice(); }

  function stripHash(value) {
    var s = String(value == null ? '' : value);
    var at = s.indexOf('#');
    return at === -1 ? s : s.slice(0, at);
  }

  function searchPart(input) {
    if (input == null) return '';
    var raw;
    if (typeof input === 'object' && typeof input.search === 'string') raw = input.search;
    else raw = String(input);
    raw = stripHash(raw);
    var q = raw.indexOf('?');
    if (q !== -1) raw = raw.slice(q + 1);
    else if (raw.charAt(0) === '?') raw = raw.slice(1);
    /* A full URL with no query is not itself a parameter string. */
    if (raw.indexOf('=') === -1 && raw.indexOf('&') === -1) return '';
    return raw;
  }

  function decode(value) {
    try { return decodeURIComponent(String(value || '').replace(/\+/g, ' ')); }
    catch (e) { return ''; }
  }

  function readPairs(search) {
    var out = {};
    if (!search) return out;
    if (typeof URLSearchParams !== 'undefined') {
      var params = new URLSearchParams(search);
      PARAMS.concat(['query']).forEach(function (key) {
        if (params.has(key)) out[key] = params.get(key);
      });
      return out;
    }
    search.split('&').forEach(function (pair) {
      var at = pair.indexOf('=');
      var key = decode(at === -1 ? pair : pair.slice(0, at));
      if (PARAMS.indexOf(key) === -1 && key !== 'query') return;
      if (out[key] !== undefined) return;
      out[key] = decode(at === -1 ? '' : pair.slice(at + 1));
    });
    return out;
  }

  function cleanQuery(value) {
    var s = String(value == null ? '' : value).replace(CONTROL, ' ')
      .replace(/\s+/g, ' ').trim();
    return s.slice(0, MAX_QUERY).trim();
  }

  function cleanValue(value, max) {
    var raw = String(value == null ? '' : value);
    if (CONTROL.test(raw)) { CONTROL.lastIndex = 0; return ''; }
    CONTROL.lastIndex = 0;
    var s = raw.trim();
    if (!s || s.length > (max || MAX_VALUE) || UNSAFE_VALUE.test(s)) return '';
    return s;
  }

  function listAllows(value, list) {
    return !Array.isArray(list) || list.indexOf(value) !== -1;
  }

  function allowedValue(key, value, options) {
    var s = cleanValue(value);
    if (!s) return '';
    if (BUILT_IN[key] && BUILT_IN[key].indexOf(s) === -1) return '';
    var optionKey = OPTION_LIST[key];
    if (optionKey && !listAllows(s, options && options[optionKey])) return '';
    return s;
  }

  function booleanValue(value) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    var s = String(value == null ? '' : value).trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
    return null;
  }

  function dateValue(value) {
    var s = String(value == null ? '' : value).trim();
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 &&
      d.getUTCDate() === +m[3] ? s : '';
  }

  function tabList(view, options) {
    var base = TABS[view] || [];
    var scoped = options && options.tabs && options.tabs[view];
    return Array.isArray(scoped)
      ? base.filter(function (tab) { return scoped.indexOf(tab) !== -1; })
      : base;
  }

  /* Normalize a route-shaped object.  Unknown object keys are ignored just as
     unknown URL parameters are.  Optional value lists let the caller apply
     runtime facts such as account-authorized markets without putting them into
     this otherwise static module. */
  function sanitize(input, options) {
    input = input || {};
    options = options || {};
    var out = {};

    var view = cleanValue(input.view);
    if (VIEWS.indexOf(view) === -1 || !listAllows(view, options.views)) view = DEFAULTS.view;
    out.view = view;

    var badge = String(input.badge == null ? '' : input.badge).trim();
    if (view === 'profile') {
      if (!BADGE.test(badge)) out.view = 'associates';
      else out.badge = badge;
    }

    var tabs = tabList(out.view, options);
    var tab = cleanValue(input.tab);
    if (tab && tabs.indexOf(tab) !== -1) out.tab = tab;

    var market = allowedValue('market', input.market == null ? DEFAULTS.market : input.market, options);
    out.market = market || DEFAULTS.market;

    var query = cleanQuery(input.query == null ? input.q : input.query);
    if (query) out.query = query;

    ['status', 'source', 'filter', 'kind', 'urgency', 'site', 'when', 'health',
      'coverageStatus', 'location', 'reviewId'].forEach(function (key) {
      var value = allowedValue(key, input[key], options);
      if (value) out[key] = value;
    });

    var showDone = booleanValue(input.showDone);
    if (showDone !== null) out.showDone = showDone;

    var reviewDate = dateValue(input.reviewDate);
    if (reviewDate) out.reviewDate = reviewDate;

    return out;
  }

  function parse(input, options) {
    var pairs = readPairs(searchPart(input));
    var raw = {
      view: pairs.view,
      badge: pairs.badge,
      tab: pairs.tab,
      market: pairs.market,
      query: pairs.q === undefined ? pairs.query : pairs.q
    };
    FILTER_KEYS.forEach(function (key) {
      if (pairs[key] !== undefined) raw[key] = pairs[key];
    });
    return sanitize(raw, options);
  }

  function encodePairs(pairs) {
    if (typeof URLSearchParams !== 'undefined') {
      var params = new URLSearchParams();
      pairs.forEach(function (pair) { params.append(pair[0], pair[1]); });
      return params.toString();
    }
    return pairs.map(function (pair) {
      return encodeURIComponent(pair[0]) + '=' + encodeURIComponent(pair[1]);
    }).join('&');
  }

  /* Produce only `?key=value`; never a path and never a fragment.  Defaults and
     false/"all" filters are omitted so changing a filter back to its neutral
     state also cleans the address bar. */
  function serialize(input, options) {
    var route = sanitize(input, options);
    var pairs = [];
    if (route.view !== DEFAULTS.view) pairs.push(['view', route.view]);
    if (route.badge) pairs.push(['badge', route.badge]);
    if (route.tab) pairs.push(['tab', route.tab]);
    if (route.market !== DEFAULTS.market) pairs.push(['market', route.market]);
    if (route.query) pairs.push(['q', route.query]);
    FILTER_KEYS.forEach(function (key) {
      var value = route[key];
      if (key === 'showDone') {
        if (value === true) pairs.push([key, '1']);
        return;
      }
      if (value && value !== 'all') pairs.push([key, value]);
    });
    var search = encodePairs(pairs);
    return search ? '?' + search : '';
  }

  var api = {
    VIEWS: copyArray(VIEWS),
    TABS: { settings: copyArray(TABS.settings), payroll: copyArray(TABS.payroll) },
    PARAMS: copyArray(PARAMS),
    FILTER_KEYS: copyArray(FILTER_KEYS),
    DEFAULTS: { view: DEFAULTS.view, market: DEFAULTS.market },
    sanitize: sanitize,
    parse: parse,
    serialize: serialize,
    toSearch: serialize
  };

  root.RouterCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
