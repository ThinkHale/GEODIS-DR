/* SuiteAuth without Firebase, for the DOM tests.
   The real module pulls the SDK from a CDN, which jsdom cannot reach and which
   these tests are not about. Same surface, no network. */
(function (root) {
  /* Signed in as a colleague by default: the suite is gated now, so a stub that
     starts signed out would render the sign-in card in every DOM test rather
     than the page under test. Tests that care about the gate, or about what a
     read-only account sees, call __setAuth themselves. */
  var COLLEAGUE = { email: 'tester@geodis.com', name: 'Tester', role: 'colleague',
    enabled: true, markets: [] };
  var snap = { ready: true, signedIn: true, email: COLLEAGUE.email, account: COLLEAGUE,
    loading: false, error: '', denied: '' };
  var listeners = [];
  root.__setAuth = function (next) {
    snap = Object.assign({}, snap, next);
    listeners.forEach(function (fn) { fn(snap); });
  };
  // Shorthand for the role tests actually vary.
  root.__setRole = function (role) {
    root.__setAuth({ ready: true, signedIn: true, email: 'tester@geodis.com',
      account: Object.assign({}, COLLEAGUE, { role: role }) });
  };
  root.SuiteAuth = {
    onChange: function (fn) { listeners.push(fn); fn(snap); },
    snapshot: function () { return snap; },
    resume: function () {},
    noteDenied: function (m) { root.__setAuth({ denied: m || '' }); },
    signIn: function () { return Promise.resolve(); },
    createAccount: function () { return Promise.resolve(); },
    resetPassword: function () { return Promise.resolve(); },
    signOut: function () { root.__setAuth({ signedIn: false, email: '', account: null }); return Promise.resolve(); },
    /* Empty when signed out, exactly as the real module behaves
       (`state.user ? getIdToken() : Promise.resolve('')`). Handing out a token
       unconditionally made every DOM test look authenticated from frame zero,
       which is a state the real page is never in -- and it is precisely why a
       boot that asked for the roster before sign-in resolved passed here and
       returned 401 in production. */
    idToken: function () { return Promise.resolve(snap.signedIn ? 'test-token' : ''); }
  };
})(typeof window !== 'undefined' ? window : this);
