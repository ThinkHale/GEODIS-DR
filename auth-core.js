/* GEODIS Management Suite -- accounts, roles and what they may do.
 *
 * Sign-in is email and password (Firebase Auth), open to approved company
 * domains. Everything about WHO may do WHAT lives here, as plain functions with
 * no Firebase dependency, so the browser and the Cloud Function decide access
 * the same way and both can be tested without a network.
 *
 * Two rules worth stating up front, because they are the ones that go wrong:
 *
 *   1. An unknown role grants nothing. A typo in a role name must not quietly
 *      hand somebody admin, and it must not lock the app open either.
 *   2. Disabled beats everything. A disabled account has no permissions at all,
 *      whatever its role says, because that is the switch someone reaches for
 *      when a person leaves.
 */
(function (root) {
  'use strict';

  /* Anyone with an address at one of these may create an account. Anyone else is
     refused at sign-up AND at sign-in -- checking only at sign-up would leave an
     account working after a domain was removed from the list. */
  var ALLOWED_DOMAINS = ['geodis.com', 'employbridge.com'];

  /* Roles, least to most. `rank` exists so an admin cannot be demoted by someone
     who is not at least their equal, and so the UI can offer only the roles the
     signed-in person is allowed to grant. */
  var ROLES = [
    { key: 'pending', label: 'No access', rank: 0, can: [] },
    { key: 'viewer', label: 'Viewer', rank: 1, can: ['view'] },
    { key: 'manager', label: 'Manager', rank: 2, can: ['view', 'edit', 'import'] },
    { key: 'admin', label: 'Administrator', rank: 3, can: ['view', 'edit', 'import', 'admin'] }
  ];
  // What a new account from an approved domain gets before an admin decides.
  var DEFAULT_ROLE = 'viewer';

  var BY_KEY = {};
  ROLES.forEach(function (r) { BY_KEY[r.key] = r; });

  function emailDomain(email) {
    var s = String(email == null ? '' : email).trim().toLowerCase();
    var at = s.lastIndexOf('@');
    return at === -1 ? '' : s.slice(at + 1);
  }
  function normalizeEmail(email) {
    return String(email == null ? '' : email).trim().toLowerCase();
  }
  function domainAllowed(email, domains) {
    var list = domains && domains.length ? domains : ALLOWED_DOMAINS;
    var d = emailDomain(email);
    if (!d) return false;
    return list.some(function (x) { return String(x).trim().toLowerCase() === d; });
  }

  /* An unrecognised role is treated as `pending`: no permissions. It is NOT
     coerced into the list, so the stored value stays visible to an admin who has
     to work out what happened. */
  function roleMeta(key) {
    var k = String(key == null ? '' : key).trim();
    return BY_KEY[k] || { key: k || 'pending', label: k ? k + ' (unknown)' : 'No access',
      rank: 0, can: [], unknown: !!k };
  }

  /* The stored shape of an account. Keyed by email, because that is what the
     person types and what an admin invites -- the Firebase uid is recorded
     alongside once they actually sign in. */
  function normalizeUser(rec) {
    rec = rec || {};
    var email = normalizeEmail(rec.email || rec.id);
    return {
      id: email,
      email: email,
      uid: String(rec.uid || ''),
      name: String(rec.name || '').trim(),
      role: roleMeta(rec.role).key,
      // Empty means every market. A market list is a restriction, not a grant,
      // so a new account is not accidentally scoped to nothing.
      markets: Array.isArray(rec.markets) ? rec.markets.filter(Boolean).map(String) : [],
      enabled: rec.enabled === undefined ? true : !!rec.enabled,
      createdAt: rec.createdAt || '',
      lastSeenAt: rec.lastSeenAt || ''
    };
  }

  /* Can this account do this thing?

     Order matters: no account, then disabled, then domain, then role. A disabled
     admin is not an admin. */
  function can(user, action) {
    if (!user) return false;
    var u = normalizeUser(user);
    if (!u.enabled) return false;
    if (!domainAllowed(u.email)) return false;
    return roleMeta(u.role).can.indexOf(action) !== -1;
  }
  function isAdmin(user) { return can(user, 'admin'); }
  function canEdit(user) { return can(user, 'edit'); }

  /* Markets are a restriction. An empty list means the whole business, which is
     what most accounts want; a non-empty list means only those. */
  function canSeeMarket(user, market) {
    var u = normalizeUser(user);
    if (!u.markets.length) return true;
    if (!market) return true;       // records with no market are never hidden
    return u.markets.indexOf(market) !== -1;
  }
  function visibleMarkets(user, allMarkets) {
    var u = normalizeUser(user);
    var all = (allMarkets || []).slice();
    if (!u.markets.length) return all;
    return all.filter(function (m) { return u.markets.indexOf(m) !== -1; });
  }

  /* Who may grant which role. You cannot promote anybody above yourself, and you
     cannot change an account that outranks you -- otherwise a manager could make
     themselves an admin by editing an admin's row. */
  function grantableRoles(actor) {
    var mine = roleMeta(normalizeUser(actor).role).rank;
    if (!isAdmin(actor)) return [];
    return ROLES.filter(function (r) { return r.rank <= mine; }).map(function (r) { return r.key; });
  }
  function canManage(actor, target) {
    if (!isAdmin(actor)) return false;
    var a = normalizeUser(actor), t = normalizeUser(target);
    if (a.email === t.email) return false;          // no editing your own access
    return roleMeta(a.role).rank >= roleMeta(t.role).rank;
  }

  /* What a first sign-in produces. Refused outright when the domain is not
     approved -- the account is never created, so there is nothing to clean up. */
  function accountFor(email, name, now) {
    var e = normalizeEmail(email);
    if (!domainAllowed(e)) {
      return { ok: false, error: 'Only ' + ALLOWED_DOMAINS.join(' and ') + ' addresses can be used here.' };
    }
    return {
      ok: true,
      user: normalizeUser({
        email: e, name: name || '', role: DEFAULT_ROLE, enabled: true,
        createdAt: (now || new Date()).toISOString()
      })
    };
  }

  var api = {
    ALLOWED_DOMAINS: ALLOWED_DOMAINS,
    ROLES: ROLES,
    ROLE_KEYS: ROLES.map(function (r) { return r.key; }),
    DEFAULT_ROLE: DEFAULT_ROLE,
    emailDomain: emailDomain,
    normalizeEmail: normalizeEmail,
    domainAllowed: domainAllowed,
    roleMeta: roleMeta,
    normalizeUser: normalizeUser,
    can: can,
    isAdmin: isAdmin,
    canEdit: canEdit,
    canSeeMarket: canSeeMarket,
    visibleMarkets: visibleMarkets,
    grantableRoles: grantableRoles,
    canManage: canManage,
    accountFor: accountFor
  };
  root.AuthCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
