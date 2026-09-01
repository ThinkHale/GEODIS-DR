/* The permission gate, for the Cloud Function tests.
 *
 * functions/index.js is not required directly by these suites -- it reaches for
 * live Firebase credentials at load. They slice the real source out of the file
 * and run it against fakes instead, which is what makes them test the shipped
 * code rather than a copy of it. Once every browser-facing handler went behind
 * requireUser(), each of those slices needed two more things in scope: the
 * Firebase Admin SDK, to verify a token, and the account rules.
 *
 * Both are provided here so no suite grows its own half-version.
 *
 * `token` is the whole protocol: 'test-token' is whoever `as()` last said, and
 * anything else is a forged token that fails verification, which is what an
 * unauthenticated caller looks like from inside the handler.
 */
const Auth = require('../functions/auth-core.js');

const DEFAULT = { email: 'tester@geodis.com', name: 'Tester', role: 'admin', enabled: true, markets: [] };

function makeAuth(opts) {
  opts = opts || {};
  let account = opts.account === undefined ? Object.assign({}, DEFAULT) : opts.account;

  const admin = {
    auth: () => ({
      verifyIdToken: async (token) => {
        if (token !== 'test-token' || !account) {
          const err = new Error('Invalid token');
          err.code = 'auth/argument-error';
          throw err;
        }
        return { uid: 'uid-' + account.email, email: account.email, name: account.name || '' };
      }
    })
  };

  /* Stands in for the real requireUser in the suites whose slice of the source
     does not reach it. Deliberately the same shape and the same status codes:
     a suite that is not about auth should still fail the same way if a handler
     stops checking. */
  async function requireUser(req, res, action) {
    const header = String((req.get && req.get('authorization')) || '');
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m || m[1] !== 'test-token' || !account) {
      res.status(401).json({ ok: false, error: 'Sign in to use this.', signIn: true });
      return null;
    }
    const user = Auth.normalizeUser(account);
    if (!Auth.can(user, action)) {
      res.status(403).json({ ok: false, forbidden: true, error: 'Not allowed.' });
      return null;
    }
    return user;
  }

  return {
    Auth: Auth,
    admin: admin,
    requireUser: requireUser,
    // Who the next 'test-token' belongs to. null means nobody is signed in.
    as: (a) => { account = a === null ? null : Object.assign({}, DEFAULT, a); },
    account: () => account,
    // What a signed-in browser sends.
    headers: { authorization: 'Bearer test-token' }
  };
}

/* The `get` a handler calls: `req.get('origin')` and `req.get('authorization')`.
   Suites used to pass `() => ORIGIN`, which answered every header with the
   origin -- harmless until something started reading a second one. */
function reqGet(headers) {
  const lower = {};
  Object.keys(headers || {}).forEach(k => { lower[k.toLowerCase()] = headers[k]; });
  return (name) => lower[String(name).toLowerCase()];
}

module.exports = { makeAuth, reqGet, Auth };
