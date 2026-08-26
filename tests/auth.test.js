/* Accounts, roles and permissions. */
const A = require('../auth-core.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };
const user = o => Object.assign({ email: 'a@geodis.com', role: 'manager', enabled: true }, o);

console.log('— approved domains —');
t('geodis.com allowed', A.domainAllowed('cody@geodis.com'));
t('employbridge.com allowed', A.domainAllowed('someone@employbridge.com'));
t('gmail refused', !A.domainAllowed('someone@gmail.com'));
t('a lookalike domain is refused', !A.domainAllowed('x@notgeodis.com'));
t('a subdomain is refused', !A.domainAllowed('x@mail.geodis.com'));
t('case does not matter', A.domainAllowed('Cody@GEODIS.COM'));
t('whitespace does not matter', A.domainAllowed('  cody@geodis.com  '));
t('no address refused', !A.domainAllowed('') && !A.domainAllowed(null));
t('no @ refused', !A.domainAllowed('geodis.com'));
t('an @ in the local part uses the LAST one', A.emailDomain('a@b@geodis.com') === 'geodis.com');

console.log('— roles —');
t('viewer can view', A.can(user({ role: 'viewer' }), 'view'));
t('viewer cannot edit', !A.can(user({ role: 'viewer' }), 'edit'));
t('manager can edit', A.can(user({ role: 'manager' }), 'edit'));
t('manager can import', A.can(user({ role: 'manager' }), 'import'));
t('manager is NOT an admin', !A.isAdmin(user({ role: 'manager' })));
t('admin can do everything', ['view', 'edit', 'import', 'admin'].every(x => A.can(user({ role: 'admin' }), x)));
t('pending can do nothing', !A.can(user({ role: 'pending' }), 'view'));

console.log('— the two rules that go wrong —');
t('an unknown role grants nothing', !A.can(user({ role: 'superuser' }), 'view'));
t('and does not lock the app open', !A.can(user({ role: 'superuser' }), 'admin'));
t('the unknown value is kept visible, not coerced', A.roleMeta('superuser').key === 'superuser');
t('and flagged as unknown', A.roleMeta('superuser').unknown === true);
t('a disabled admin is not an admin', !A.isAdmin(user({ role: 'admin', enabled: false })));
t('disabled beats every permission',
  ['view', 'edit', 'import', 'admin'].every(x => !A.can(user({ role: 'admin', enabled: false }), x)));
t('an off-domain account has no permissions even with a role',
  !A.can(user({ email: 'x@gmail.com', role: 'admin' }), 'view'));
t('no user at all is refused', !A.can(null, 'view'));

console.log('— markets are a restriction, not a grant —');
t('no market list sees everything', A.canSeeMarket(user({ markets: [] }), 'Chicago'));
t('a list restricts', A.canSeeMarket(user({ markets: ['Chicago'] }), 'Chicago'));
t('and excludes the rest', !A.canSeeMarket(user({ markets: ['Chicago'] }), 'St. Louis'));
t('a record with no market is never hidden', A.canSeeMarket(user({ markets: ['Chicago'] }), ''));
t('visibleMarkets with no list returns all',
  A.visibleMarkets(user({ markets: [] }), ['Chicago', 'St. Louis']).length === 2);
t('visibleMarkets filters',
  JSON.stringify(A.visibleMarkets(user({ markets: ['Chicago'] }), ['Chicago', 'St. Louis'])) === '["Chicago"]');

console.log('— nobody escalates themselves —');
const admin = user({ email: 'admin@geodis.com', role: 'admin' });
const mgr = user({ email: 'mgr@geodis.com', role: 'manager' });
t('a manager can grant nothing', A.grantableRoles(mgr).length === 0);
t('an admin can grant every role', A.grantableRoles(admin).length === A.ROLE_KEYS.length);
t('a manager cannot manage anyone', !A.canManage(mgr, user({ role: 'viewer' })));
t('an admin can manage a manager', A.canManage(admin, mgr));
t('an admin can manage another admin', A.canManage(admin, user({ email: 'other@geodis.com', role: 'admin' })));
t('but NOT their own account', !A.canManage(admin, admin));
t('a disabled admin manages nobody', !A.canManage(user({ role: 'admin', enabled: false }), mgr));

console.log('— a first sign-in —');
let r = A.accountFor('New.Person@geodis.com', 'New Person');
t('accepted for an approved domain', r.ok === true);
t('email normalised', r.user.email === 'new.person@geodis.com');
t('keyed by email', r.user.id === r.user.email);
t('starts as viewer, not admin', r.user.role === 'viewer');
t('enabled', r.user.enabled === true);
t('sees every market by default', r.user.markets.length === 0);
t('stamped', !!r.user.createdAt);
r = A.accountFor('outsider@gmail.com', 'Outsider');
t('refused for an unapproved domain', r.ok === false);
t('with a message naming the domains', r.error.indexOf('geodis.com') !== -1 && r.error.indexOf('employbridge.com') !== -1);
t('and no account is produced to clean up', r.user === undefined);

console.log('— the stored shape —');
const n = A.normalizeUser({ email: ' A@GEODIS.com ', role: 'manager', markets: ['Chicago', ''], enabled: undefined });
t('email trimmed and lowered', n.email === 'a@geodis.com');
t('blank markets dropped', JSON.stringify(n.markets) === '["Chicago"]');
t('enabled defaults to true', n.enabled === true);
t('explicit false is respected', A.normalizeUser({ email: 'a@geodis.com', enabled: false }).enabled === false);
t('a missing role becomes pending', A.normalizeUser({ email: 'a@geodis.com' }).role === 'pending');
t('markets that are not an array become empty',
  A.normalizeUser({ email: 'a@geodis.com', markets: 'Chicago' }).markets.length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
