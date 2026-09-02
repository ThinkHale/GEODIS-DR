/* Shareable URL route + filter state. */
const R = require('../router-core.js');
let pass = 0, fail = 0;
const t = (name, condition) => {
  if (condition) pass++;
  else { fail++; console.log('  FAIL: ' + name); }
};
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

console.log('— route vocabulary —');
t('every suite destination is an allowed view',
  ['overview', 'tasks', 'associates', 'profile', 'coverage', 'attendance', 'timeoff',
    'payroll', 'requisitions', 'reconciliation', 'settings']
    .every(view => R.VIEWS.indexOf(view) !== -1));
t('the URL vocabulary is explicit',
  ['view', 'badge', 'tab', 'market', 'q', 'status', 'source', 'filter']
    .every(key => R.PARAMS.indexOf(key) !== -1));
t('page-specific filters are explicit too',
  ['kind', 'urgency', 'showDone', 'site', 'when', 'health', 'coverageStatus',
    'location', 'reviewDate', 'reviewId']
    .every(key => R.FILTER_KEYS.indexOf(key) !== -1));

console.log('— parsing and sanitizing —');
let route = R.parse('https://example.test/tool?view=tasks&market=Chicago&q=late+arrival' +
  '&status=In+Progress&source=timeoff&filter=needsAction&unknown=keep-me-out#settings');
t('a full URL parses its route', route.view === 'tasks');
t('market parses', route.market === 'Chicago');
t('q becomes the state query property', route.query === 'late arrival');
t('human-readable status parses', route.status === 'In Progress');
t('source and filter parse', route.source === 'timeoff' && route.filter === 'needsAction');
t('unknown parameters never enter route state', !own(route, 'unknown'));
t('the hash cannot replace query state', route.view === 'tasks' && route.query === 'late arrival');

route = R.parse('?view=tasks&query=associate+123');
t('query is accepted as a legacy input alias', route.query === 'associate 123');
t('q wins when both query spellings exist',
  R.parse('?view=tasks&q=canonical&query=legacy').query === 'canonical');

route = R.parse('?view=does-not-exist&market=%3Cscript%3E');
t('an invalid view falls back to Overview', route.view === 'overview');
t('an unsafe market falls back to all markets', route.market === 'all');
t('control characters are removed from free-text search',
  R.sanitize({ view: 'tasks', query: ' Ann\u0000  Chi\n ' }).query === 'Ann Chi');
t('search is bounded', R.sanitize({ query: 'x'.repeat(240) }).query.length === 200);

console.log('— profiles and route-specific tabs —');
route = R.parse('?view=profile&badge=80-123.4');
t('a valid profile badge is retained', route.view === 'profile' && route.badge === '80-123.4');
t('profile without a badge falls back to the roster',
  R.parse('?view=profile').view === 'associates');
t('an invalid profile badge falls back to the roster',
  R.parse('?view=profile&badge=%3Cbad%3E').view === 'associates');
t('badge is not leaked onto unrelated routes',
  !own(R.parse('?view=tasks&badge=80-123'), 'badge'));
t('a Settings tab is accepted on Settings',
  R.parse('?view=settings&tab=users').tab === 'users');
t('a Payroll tab is accepted on Payroll',
  R.parse('?view=payroll&tab=hours').tab === 'hours');
t('a tab from the wrong route is discarded',
  !own(R.parse('?view=settings&tab=hours'), 'tab'));
t('tab permissions can narrow the static vocabulary',
  !own(R.parse('?view=settings&tab=users', { tabs: { settings: ['account'] } }), 'tab'));

console.log('— runtime allowlists —');
t('an authorized market survives its runtime allowlist',
  R.parse('?market=Chicago', { markets: ['Chicago'] }).market === 'Chicago');
t('an unauthorized market fails closed to all',
  R.parse('?market=St.+Louis', { markets: ['Chicago'] }).market === 'all');
route = R.parse('?view=tasks&status=Blocked&source=timeoff&filter=needsAction&kind=pto&site=100', {
  statuses: ['Open'], sources: ['hand'], filters: ['all'], kinds: ['payroll'], sites: ['200']
});
t('runtime filter allowlists reject every value outside scope',
  ['status', 'source', 'filter', 'kind', 'site'].every(key => !own(route, key)));

console.log('— page filter values —');
route = R.parse('?view=coverage&status=Open&source=hand&filter=exceptions&kind=pto' +
  '&urgency=urgent&showDone=yes&site=100&when=week&health=short' +
  '&coverageStatus=missing&location=Dock+A&reviewDate=2026-09-01&reviewId=check-01');
t('generic status/source/filter values parse',
  route.status === 'Open' && route.source === 'hand' && route.filter === 'exceptions');
t('task filters parse', route.kind === 'pto' && route.urgency === 'urgent' && route.showDone === true);
t('request filters parse', route.site === '100' && route.when === 'week' && route.health === 'short');
t('coverage filters parse',
  route.coverageStatus === 'missing' && route.location === 'Dock A' &&
  route.reviewDate === '2026-09-01' && route.reviewId === 'check-01');

route = R.parse('?urgency=immediate&showDone=maybe&when=someday&health=orange' +
  '&coverageStatus=broken&reviewDate=2026-02-30&source=%3Cscript%3E');
t('invalid enumerated filters are discarded',
  ['urgency', 'showDone', 'when', 'health', 'coverageStatus', 'reviewDate', 'source']
    .every(key => !own(route, key)));
t('an explicit false boolean is retained when parsing',
  R.parse('?showDone=false').showDone === false);

console.log('— deterministic serialization —');
const state = {
  view: 'tasks', market: 'Chicago', query: 'Ann & Bob #2', status: 'all',
  source: 'timeoff', filter: 'all', showDone: true, ignored: 'never serialized'
};
const search = R.serialize(state);
t('serialization uses one canonical parameter order',
  search === '?view=tasks&market=Chicago&q=Ann+%26+Bob+%232&source=timeoff&showDone=1');
t('serialization contains no literal hash fragment', search.indexOf('#') === -1);
t('unknown state is not serialized', search.indexOf('ignored') === -1);
t('neutral defaults produce a clean URL', R.serialize({ view: 'overview', market: 'all' }) === '');
t('the toSearch alias is identical', R.toSearch(state) === search);
t('serialization does not mutate caller state',
  state.query === 'Ann & Bob #2' && state.status === 'all' && state.ignored === 'never serialized');

const profileSearch = R.serialize({ view: 'profile', badge: '80-123', market: 'St. Louis' });
t('profile links serialize badge and encoded market',
  profileSearch === '?view=profile&badge=80-123&market=St.+Louis');
route = R.parse(profileSearch, { markets: ['St. Louis'] });
t('canonical output round-trips',
  route.view === 'profile' && route.badge === '80-123' && route.market === 'St. Louis');
t('invalid state is sanitized during serialization',
  R.serialize({ view: 'javascript:alert(1)', market: '<all>' }) === '');
t('a Location-like object is supported',
  R.parse({ search: '?view=payroll&tab=hours#ignored' }).tab === 'hours');
t('a full URL without a query returns defaults',
  R.parse('https://example.test/tool#view=settings').view === 'overview');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
