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

  /* Anyone with an address at one of these may create an account -- sign-up is
     self-service, nobody has to be invited. Anyone else is refused at sign-up
     AND at sign-in: checking only at sign-up would leave an account working
     after a domain was removed from the list.

     The list is a floor, not the whole story. An administrator can widen it from
     Settings without a deploy (`allowedDomains`), which is what "anyone can
     create an account" means in practice -- anyone the business recognises. It
     is deliberately NOT open to the whole internet, because a new account can
     read the floor from its first minute and that is the thing being protected. */
  var ALLOWED_DOMAINS = ['geodis.com', 'employbridge.com'];

  /* Roles, least to most.

     `rank` exists so an admin cannot be demoted by someone who is not at least
     their equal, and so the UI can offer only the roles the signed-in person is
     allowed to grant. `can` is the whole permission model: an action is allowed
     only if it is named here.

       read-only   sees the day, changes nothing. NOT the default -- it is what
                   somebody is put on deliberately, e.g. an account that only
                   needs to read the floor, or one being wound down.
       colleague   the working role, and what every new account starts as.
                   Everything the tool does day to day -- status changes,
                   documenting the floor, importing a report.
       manager     a colleague who can also hand out roles, up to and including
                   another manager. Not admin: promoting somebody to the role
                   that controls settings is an administrator's decision.
       admin       everything, plus the settings panel.

     'roles' is separated from 'admin' on purpose. It is what lets a manager
     staff their own team without also handing them the RC base URL, the domain
     allowlist and the ability to disable an administrator. */
  var ROLES = [
    { key: 'pending', label: 'No access', rank: 0, can: [] },
    { key: 'viewer', label: 'Read-only', rank: 1, can: ['view'] },
    { key: 'colleague', label: 'Colleague', rank: 2, can: ['view', 'edit', 'import'] },
    { key: 'manager', label: 'Manager', rank: 3, can: ['view', 'edit', 'import', 'roles'] },
    { key: 'admin', label: 'Administrator', rank: 4, can: ['view', 'edit', 'import', 'roles', 'admin'] }
  ];
  /* What a new account gets before anybody decides anything.

     This leans on the domain gate above doing the real work: only somebody with
     a geodis.com or employbridge.com address can create an account at all, and
     everyone who has one is already trusted with the floor. Landing them on
     Colleague means the tool works the moment they sign in, rather than needing
     a second person before it does anything -- which is the friction that gets a
     tool abandoned in its first week.

     What it costs: the domain gate is now the ONLY thing between a new sign-up
     and editing shared records. Anyone at either domain who signs up can change
     time-off statuses and import reports without anybody approving them. The
     answer if that stops being acceptable is to set this back to 'viewer', not
     to add a second check somewhere else. */
  var DEFAULT_ROLE = 'colleague';

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
  /* The list actually in force. Starts as the built-ins and can be WIDENED from
     Settings, never narrowed: a mistyped domain field must not be able to lock
     out every administrator, and there is no way back in from that state. Both
     the browser and the Cloud Function call setAllowedDomains() once they have
     read the app config, so the two agree. */
  var allowedDomains = ALLOWED_DOMAINS.slice();
  function setAllowedDomains(list) {
    var extra = (Array.isArray(list) ? list : String(list || '').split(','))
      .map(function (x) { return String(x).trim().toLowerCase().replace(/^@/, ''); })
      .filter(function (x) { return x && ALLOWED_DOMAINS.indexOf(x) === -1; });
    allowedDomains = ALLOWED_DOMAINS.concat(extra);
    return allowedDomains.slice();
  }
  function allowedDomainList() { return allowedDomains.slice(); }
  function domainAllowed(email, domains) {
    var list = domains && domains.length ? domains : allowedDomains;
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
  function canView(user) { return can(user, 'view'); }
  function canImport(user) { return can(user, 'import'); }

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

  /* What is wrong with these credentials, in words, before anything is sent.

     This exists because the domain check was doing double duty. An empty box and
     a personal address both came back "Only geodis.com and employbridge.com
     addresses can be used here" -- and somebody who HAS an employbridge.com
     address, reading that after clicking a button before filling the form in,
     concludes their address was rejected. Which is the one thing it does not
     mean.

     `mode` is 'in' | 'create' | 'reset'; reset needs no password. Returns '' when
     there is nothing to say. This is a courtesy for the person typing, never a
     control: the server checks the domain again and decides. */
  var MIN_PASSWORD = 6;
  function credentialProblem(email, password, mode) {
    var e = String(email == null ? '' : email).trim();
    if (!e) return 'Enter your work email address.';
    if (e.indexOf('@') === -1 || !emailDomain(e)) {
      return '"' + e + '" is not a complete email address.';
    }
    if (!domainAllowed(e)) {
      return 'That address is at ' + emailDomain(e) + '. This tool is open to ' +
        allowedDomains.join(' and ') + ' addresses.';
    }
    if (mode === 'reset') return '';
    var p = String(password == null ? '' : password);
    if (!p) {
      return mode === 'create'
        ? 'Choose a password of at least ' + MIN_PASSWORD + ' characters.'
        : 'Enter your password.';
    }
    if (mode === 'create' && p.length < MIN_PASSWORD) {
      return 'That password is ' + p.length + ' character' + (p.length === 1 ? '' : 's') +
        ' — it needs at least ' + MIN_PASSWORD + '.';
    }
    return '';
  }

  /* Who may grant which role. You cannot promote anybody above yourself, and you
     cannot change an account that outranks you -- otherwise a manager could make
     themselves an admin by editing an admin's row, or by editing their own.

     A manager's ceiling is therefore Manager: they can staff colleagues and
     other managers, and cannot create an administrator. */
  function canAssignRoles(actor) { return can(actor, 'roles'); }
  function grantableRoles(actor) {
    if (!canAssignRoles(actor)) return [];
    var mine = roleMeta(normalizeUser(actor).role).rank;
    return ROLES.filter(function (r) { return r.rank <= mine; }).map(function (r) { return r.key; });
  }
  function canManage(actor, target) {
    if (!canAssignRoles(actor)) return false;
    var a = normalizeUser(actor), t = normalizeUser(target);
    if (a.email === t.email) return false;          // no editing your own access
    return roleMeta(a.role).rank >= roleMeta(t.role).rank;
  }
  /* Can the actor put this target ON this role? Both halves have to hold: the
     role has to be one they may grant, and the account has to be one they may
     touch. Checked server-side too -- a select element is not a permission. */
  function canGrant(actor, target, role) {
    if (!canManage(actor, target)) return false;
    return grantableRoles(actor).indexOf(roleMeta(role).key) !== -1;
  }

  /* What a first sign-in produces. Refused outright when the domain is not
     approved -- the account is never created, so there is nothing to clean up. */
  function accountFor(email, name, now) {
    var e = normalizeEmail(email);
    if (!domainAllowed(e)) {
      return { ok: false, error: 'Only ' + allowedDomains.join(' and ') + ' addresses can be used here.' };
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
    setAllowedDomains: setAllowedDomains,
    allowedDomainList: allowedDomainList,
    MIN_PASSWORD: MIN_PASSWORD,
    credentialProblem: credentialProblem,
    roleMeta: roleMeta,
    normalizeUser: normalizeUser,
    can: can,
    isAdmin: isAdmin,
    canEdit: canEdit,
    canView: canView,
    canImport: canImport,
    canSeeMarket: canSeeMarket,
    visibleMarkets: visibleMarkets,
    canAssignRoles: canAssignRoles,
    grantableRoles: grantableRoles,
    canManage: canManage,
    canGrant: canGrant,
    accountFor: accountFor
  };
  root.AuthCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
