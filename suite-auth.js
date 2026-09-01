/* GEODIS Management Suite -- sign-in.
 *
 * Email and password via Firebase Auth, open to the approved company domains in
 * auth-core.js. Anyone at one of those domains can create their own account; it
 * starts read-only, and a manager or an administrator gives it a role.
 *
 * ENFORCED. Nothing in the suite renders, and no request to the server is
 * answered, until there is a signed-in account with a role that allows it. The
 * server is the authority -- every read and write is checked there -- and this
 * is the front door that makes that legible rather than a wall of failures.
 *
 * `ready` is the state that matters for the shell. Restoring a session is
 * asynchronous, so between load and the first onAuthStateChanged callback the
 * honest answer is "not known yet", not "signed out". Rendering the sign-in form
 * during that gap flashes it at somebody who is already signed in, and worse,
 * invites them to type a password they did not need.
 */
(function (root) {
  'use strict';

  var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  var API = 'https://syncreport-eusvh7xq5q-uc.a.run.app/';
  var state = { app: null, auth: null, user: null, account: null, loading: false, error: '',
    ready: false, denied: '' };
  var listeners = [];

  function notify() { listeners.forEach(function (fn) { try { fn(snapshot()); } catch (e) { console.warn(e); } }); }
  function onChange(fn) { listeners.push(fn); fn(snapshot()); }
  function snapshot() {
    return {
      ready: state.ready,
      signedIn: !!state.user,
      email: state.user ? state.user.email : '',
      account: state.account,
      loading: state.loading,
      error: state.error,
      denied: state.denied
    };
  }
  // The server said no to something. Kept on the snapshot so the shell can say
  // which account was refused rather than showing an empty page.
  function noteDenied(message) { state.denied = message || ''; notify(); }

  // Pulled from the CDN on load. Every page needs it now: there is no page
  // without an account.
  function sdk() {
    if (state.app) return Promise.resolve(state.auth);
    return Promise.all([
      import(SDK + 'firebase-app.js'),
      import(SDK + 'firebase-auth.js')
    ]).then(function (mods) {
      var appMod = mods[0], authMod = mods[1];
      state.app = appMod.initializeApp(root.GEODIS_FIREBASE);
      state.auth = authMod.getAuth(state.app);
      state.authMod = authMod;
      authMod.onAuthStateChanged(state.auth, function (u) {
        state.user = u;
        // Whatever the answer, it is now known. Set before notifying so the
        // first render after this sees a settled state.
        state.ready = true;
        if (!u) { state.account = null; state.denied = ''; notify(); return; }
        register().then(notify);
      });
      return state.auth;
    });
  }

  /* Tell the server we are here. It creates the account on a first sign-in and
     hands back the stored role and markets, which is the thing the UI cares
     about -- the Firebase user object knows nothing about either. */
  function register() {
    if (!state.user) return Promise.resolve(null);
    return state.user.getIdToken().then(function (token) {
      return fetch(API + '?signIn=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ name: state.user.displayName || '' })
      });
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { state.error = d.error || 'Could not register this account.'; state.account = null; }
      else { state.account = d.account || d.user; state.error = ''; }
      return state.account;
    }).catch(function (err) {
      state.error = 'Signed in, but the account could not be loaded: ' + err.message;
      return null;
    });
  }

  /* A first check, in the browser, so somebody typing a personal address is told
     immediately rather than after a round trip. It is NOT the control: the same
     check runs on the server against the same list, and that is the one that
     decides. */
  function guardDomain(email) {
    if (root.AuthCore && !root.AuthCore.domainAllowed(email)) {
      return 'Only ' + root.AuthCore.allowedDomainList().join(' and ') + ' addresses can be used here.';
    }
    return '';
  }

  function run(fn) {
    state.loading = true; state.error = ''; notify();
    return fn().catch(function (err) {
      // Firebase error codes are not sentences. Turn the ones people actually
      // hit into something that says what to do next.
      state.error = friendly(err);
    }).then(function () { state.loading = false; notify(); });
  }
  function friendly(err) {
    var c = String((err && err.code) || '');
    if (c.indexOf('wrong-password') !== -1 || c.indexOf('invalid-credential') !== -1) return 'That email and password do not match.';
    if (c.indexOf('user-not-found') !== -1) return 'No account for that address yet — use Create account.';
    if (c.indexOf('email-already-in-use') !== -1) return 'That address already has an account — sign in instead.';
    if (c.indexOf('weak-password') !== -1) return 'Passwords need at least six characters.';
    if (c.indexOf('too-many-requests') !== -1) return 'Too many attempts. Wait a minute and try again.';
    if (c.indexOf('operation-not-allowed') !== -1) return 'Email sign-in is not switched on for this project yet.';
    if (c.indexOf('network') !== -1) return 'No connection to the sign-in service.';
    return (err && err.message) || 'Sign-in failed.';
  }

  function signIn(email, password) {
    var bad = guardDomain(email);
    if (bad) { state.error = bad; notify(); return Promise.resolve(); }
    return run(function () {
      return sdk().then(function (auth) {
        return state.authMod.signInWithEmailAndPassword(auth, email.trim(), password);
      });
    });
  }
  function createAccount(email, password) {
    var bad = guardDomain(email);
    if (bad) { state.error = bad; notify(); return Promise.resolve(); }
    return run(function () {
      return sdk().then(function (auth) {
        return state.authMod.createUserWithEmailAndPassword(auth, email.trim(), password);
      });
    });
  }
  function resetPassword(email) {
    var bad = guardDomain(email);
    if (bad) { state.error = bad; notify(); return Promise.resolve(); }
    return run(function () {
      return sdk().then(function (auth) {
        return state.authMod.sendPasswordResetEmail(auth, email.trim()).then(function () {
          state.error = 'Sent. Check ' + email.trim() + ' for the reset link.';
        });
      });
    });
  }
  function signOut() {
    return run(function () {
      return sdk().then(function (auth) { return state.authMod.signOut(auth); });
    });
  }
  /* Loads the SDK on every visit now, not only for browsers that have signed in
     before. There is nothing to see without an account, so there is no visitor
     to save the download for -- and skipping it left anybody whose local flag
     had been cleared staring at a sign-in form while their session was still
     valid. */
  function resume() {
    sdk().catch(function (err) {
      state.ready = true;
      state.error = 'The sign-in service could not be reached: ' + err.message;
      notify();
    });
  }
  root.SuiteAuth = {
    onChange: onChange, snapshot: snapshot, resume: resume, noteDenied: noteDenied,
    signIn: signIn, createAccount: createAccount, resetPassword: resetPassword, signOut: signOut,
    idToken: function () { return state.user ? state.user.getIdToken() : Promise.resolve(''); }
  };
})(typeof window !== 'undefined' ? window : this);
