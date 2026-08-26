/* SuiteAuth without Firebase, for the DOM tests.
   The real module lazy-loads the SDK from a CDN, which jsdom cannot reach and
   which these tests are not about. Same surface, signed out, no network. */
(function (root) {
  var snap = { signedIn: false, email: '', account: null, loading: false, error: '' };
  var listeners = [];
  root.__setAuth = function (next) {
    snap = Object.assign({}, snap, next);
    listeners.forEach(function (fn) { fn(snap); });
  };
  root.SuiteAuth = {
    onChange: function (fn) { listeners.push(fn); fn(snap); },
    snapshot: function () { return snap; },
    resume: function () {},
    signIn: function () { return Promise.resolve(); },
    createAccount: function () { return Promise.resolve(); },
    resetPassword: function () { return Promise.resolve(); },
    signOut: function () { root.__setAuth({ signedIn: false, email: '', account: null }); return Promise.resolve(); },
    idToken: function () { return Promise.resolve(''); }
  };
})(typeof window !== 'undefined' ? window : this);
