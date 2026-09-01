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
/* Four working roles, least to most. Read-only is what everybody starts as, and
   the only one that is safe to hand out without anybody thinking about it. */
t('read-only can view', A.can(user({ role: 'viewer' }), 'view'));
t('read-only cannot edit', !A.can(user({ role: 'viewer' }), 'edit'));
t('read-only cannot import', !A.can(user({ role: 'viewer' }), 'import'));
t('read-only cannot hand out roles', !A.can(user({ role: 'viewer' }), 'roles'));
t('a colleague can edit', A.can(user({ role: 'colleague' }), 'edit'));
t('a colleague can import', A.can(user({ role: 'colleague' }), 'import'));
t('a colleague cannot hand out roles', !A.canAssignRoles(user({ role: 'colleague' })));
t('a colleague is not an admin', !A.isAdmin(user({ role: 'colleague' })));
t('a manager has everything a colleague has',
  ['view', 'edit', 'import'].every(x => A.can(user({ role: 'manager' }), x)));
t('and can hand out roles as well', A.canAssignRoles(user({ role: 'manager' })));
t('manager is NOT an admin', !A.isAdmin(user({ role: 'manager' })));
t('so the settings panel is closed to them', !A.can(user({ role: 'manager' }), 'admin'));
t('admin can do everything',
  ['view', 'edit', 'import', 'roles', 'admin'].every(x => A.can(user({ role: 'admin' }), x)));
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
const colleague = user({ email: 'col@geodis.com', role: 'colleague' });
const reader = user({ email: 'ro@geodis.com', role: 'viewer' });
t('an admin can grant every role', A.grantableRoles(admin).length === A.ROLE_KEYS.length);
t('a manager can grant up to manager',
  JSON.stringify(A.grantableRoles(mgr)) === '["pending","viewer","colleague","manager"]');
t('and never admin -- that is an administrator\'s decision',
  A.grantableRoles(mgr).indexOf('admin') === -1);
t('a colleague grants nothing', A.grantableRoles(colleague).length === 0);
t('a read-only account grants nothing', A.grantableRoles(reader).length === 0);

t('a manager can manage a colleague', A.canManage(mgr, colleague));
t('and another manager', A.canManage(mgr, user({ email: 'mgr2@geodis.com', role: 'manager' })));
t('but not an admin', !A.canManage(mgr, admin));
t('and not their own account', !A.canManage(mgr, mgr));
t('a colleague manages nobody', !A.canManage(colleague, reader));
t('an admin can manage a manager', A.canManage(admin, mgr));
t('an admin can manage another admin', A.canManage(admin, user({ email: 'other@geodis.com', role: 'admin' })));
t('but NOT their own account', !A.canManage(admin, admin));
t('a disabled admin manages nobody', !A.canManage(user({ role: 'admin', enabled: false }), mgr));

/* canGrant is the one the server calls. Both halves have to hold, and the half
   that matters is the second: a manager who may edit a colleague's row must
   still not be able to set that row to admin. */
t('a manager may set a colleague to manager', A.canGrant(mgr, colleague, 'manager'));
t('a manager may NOT set a colleague to admin', !A.canGrant(mgr, colleague, 'admin'));
t('a manager may not touch an admin at all', !A.canGrant(mgr, admin, 'viewer'));
t('an admin may set anybody to admin', A.canGrant(admin, colleague, 'admin'));
t('an unknown role is never grantable', !A.canGrant(admin, colleague, 'superuser'));

console.log('— a first sign-in —');
let r = A.accountFor('New.Person@geodis.com', 'New Person');
t('accepted for an approved domain', r.ok === true);
t('email normalised', r.user.email === 'new.person@geodis.com');
t('keyed by email', r.user.id === r.user.email);
/* A new account can work; it cannot ADMINISTER. The domain check is what makes
   that safe -- only geodis.com and employbridge.com can create one at all. */
t('starts as a colleague', r.user.role === 'colleague');
t('which is the documented default', A.DEFAULT_ROLE === 'colleague');
t('and never as a manager or an admin',
  !A.canAssignRoles(r.user) && !A.isAdmin(r.user));
t('so a brand-new account cannot hand out roles', A.grantableRoles(r.user).length === 0);
t('enabled', r.user.enabled === true);
t('sees every market by default', r.user.markets.length === 0);
t('stamped', !!r.user.createdAt);
r = A.accountFor('outsider@gmail.com', 'Outsider');
t('refused for an unapproved domain', r.ok === false);
t('with a message naming the domains', r.error.indexOf('geodis.com') !== -1 && r.error.indexOf('employbridge.com') !== -1);
t('and no account is produced to clean up', r.user === undefined);

console.log('— the domain list can be widened, never narrowed —');
t('an outside domain is refused to begin with', !A.domainAllowed('x@acme.com'));
A.setAllowedDomains('acme.com, @partner.io');
t('adding one lets it in', A.domainAllowed('x@acme.com'));
t('a leading @ is tolerated', A.domainAllowed('x@partner.io'));
t('the built-ins survive', A.domainAllowed('x@geodis.com') && A.domainAllowed('x@employbridge.com'));
A.setAllowedDomains('');
t('clearing the field falls back to the built-ins, never to nothing',
  A.domainAllowed('x@geodis.com') && !A.domainAllowed('x@acme.com'));
t('so a mistyped setting cannot lock every administrator out',
  A.allowedDomainList().length === 2);

console.log('— the stored shape —');
const n = A.normalizeUser({ email: ' A@GEODIS.com ', role: 'colleague', markets: ['Chicago', ''], enabled: undefined });
t('email trimmed and lowered', n.email === 'a@geodis.com');
t('blank markets dropped', JSON.stringify(n.markets) === '["Chicago"]');
t('enabled defaults to true', n.enabled === true);
t('explicit false is respected', A.normalizeUser({ email: 'a@geodis.com', enabled: false }).enabled === false);
t('a missing role becomes pending', A.normalizeUser({ email: 'a@geodis.com' }).role === 'pending');
t('markets that are not an array become empty',
  A.normalizeUser({ email: 'a@geodis.com', markets: 'Chicago' }).markets.length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
