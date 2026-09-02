/* The Settings page: sign-in, and the admin lists for users, locations and shifts. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const records = [{ badge: 'b1', person: 'Zoe Adams', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' }];
let admin = {
  users: [
    { id: 'admin@geodis.com', email: 'admin@geodis.com', name: 'The Admin', role: 'admin', enabled: true, markets: [], lastSeenAt: '2026-08-26T10:00:00Z' },
    { id: 'mgr@geodis.com', email: 'mgr@geodis.com', name: 'A Manager', role: 'manager', enabled: true, markets: ['Chicago'] },
    { id: 'col@geodis.com', email: 'col@geodis.com', name: 'A Colleague', role: 'colleague', enabled: true, markets: [] },
    { id: 'temp@employbridge.com', email: 'temp@employbridge.com', name: 'Agency', role: 'viewer', enabled: false, markets: [] }
  ],
  locations: [{ id: 'LOC1', code: '1519', name: 'Lego Main', market: 'Chicago', active: true }],
  appConfig: [],
  shiftTypes: [{ id: 'SHI1', key: 'A', label: 'A shift', location: '1519', hours: '6am-4:30pm', active: true }]
};
const posts = [];
const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>h</header><main id="recon-main"><div id="tbody">R</div></main></body></html>`,
  { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
w.alert = m => posts.push({ alert: m }); w.confirm = () => true; w.scrollTo = () => {}; w.prompt = () => 'X';
w.XLSX = { read: () => ({ SheetNames: [], Sheets: {} }), utils: { sheet_to_json: x => x } };
w.fetch = (u, o) => {
  const s = String(u);
  if (o && o.method === 'POST') {
    const body = JSON.parse(o.body);
    posts.push({ url: s, body });
    const k = (s.match(/\?(\w+)=1/) || [])[1];
    if (admin[k] && body.id) {
      const i = admin[k].findIndex(x => x.id === body.id);
      if (body._delete) admin[k] = admin[k].filter(x => x.id !== body.id);
      else if (i !== -1) admin[k][i] = Object.assign({}, admin[k][i], body);
      else admin[k].push(body);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  }
  if (s.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (/schedule=1|coverage=1|payroll=1/.test(s)) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  const k = s.match(/\?(\w+)=1/)[1];
  if (admin[k]) return Promise.resolve({ ok: true, json: () => Promise.resolve({ [k]: admin[k] }) });
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions',
    performance: 'performance', shifts: 'shifts', discrepancies: 'discrepancies' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: [] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'reconcile-core.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js',
 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js', 'contacts-core.js', 'reqs-core.js', 'pto-tracker-core.js', 'suite.js']
  .forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = ms => new Promise(r => setTimeout(r, ms));
const rowFor = n => $$('.suite-table tbody tr').find(tr => tr.textContent.indexOf(n) !== -1);
const signInAs = acct => w.__setAuth({ ready: true, signedIn: true, email: acct.email, account: acct });

(async () => {
  await settle(60);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));

  /* Signing in is the GATE now, not a panel inside Settings -- nothing renders
     until there is an account. So the sign-in form is checked where it lives. */
  console.log('— signed out, there is no app at all —');
  w.__setAuth({ ready: true, signedIn: false, email: '', account: null });
  await settle(20);
  t('a sign-in card', !!$('.gate-card') && !!$('[data-signin]'));
  t('with email and password', !!$('[name="email"]') && !!$('[name="password"]'));
  t('create account is offered — anyone at the company can make one',
    !!$('[data-signin-do="create"]'));
  t('so is a password reset', !!$('[data-signin-do="reset"]'));
  t('the approved domains are named',
    d.body.textContent.indexOf('geodis.com') !== -1 && d.body.textContent.indexOf('employbridge.com') !== -1);
  click($('[data-auth-mode="create"]'));
  t('and it says a new account starts as a Colleague', /starts as a <b>Colleague<\/b>/.test(d.body.innerHTML));
  t('no navigation to anywhere', $$('.suite-nav-btn').length === 0);
  t('and none of the roster', d.body.textContent.indexOf('Luz Grachen') === -1);

  console.log('— signed in but with no role yet —');
  signInAs({ email: 'new@geodis.com', name: 'New Person', role: 'pending', enabled: true, markets: [] });
  await settle(20);
  t('still no app', $$('.suite-nav-btn').length === 0);
  t('and it says what to ask for', /manager or an administrator/i.test(d.body.textContent));
  t('sign out is the way back', !!$('[data-sign-out]'));

  console.log('— the page exists —');
  signInAs({ email: 'admin@geodis.com', name: 'The Admin', role: 'admin', enabled: true, markets: [] });
  await settle(20);
  t('Settings is in the sidebar', !!$('[data-nav="settings"]'));
  click($('[data-nav="settings"]'));
  t('six sections for an admin', $$('[data-settings-tab]').length === 6);
  t('including RC links', !!$('[data-settings-tab="links"]'));
  t('including Connections', !!$('[data-settings-tab="connections"]'));
  t('opens on Account', $('[data-settings-tab="account"]').className.indexOf('primary') !== -1);

  console.log('— signed in as an admin —');
  t('shows who you are', d.body.textContent.indexOf('admin@geodis.com') !== -1);
  t('and your role', d.body.textContent.indexOf('Administrator') !== -1);
  t('markets default to all', d.body.textContent.indexOf('All markets') !== -1);
  t('sign out is offered', !!$('[data-sign-out]'));
  t('and it spells out what the role can do', /change settings/i.test(d.body.textContent));

  console.log('— users —');
  click($('[data-settings-tab="users"]'));
  await settle(60);
  t('every account listed', $$('.suite-table tbody tr').length === 4);
  t('the disabled one is shown as such', rowFor('temp@employbridge.com').textContent.indexOf('Disable') !== -1 ||
    rowFor('temp@employbridge.com').textContent.indexOf('Enable') !== -1);
  t('an admin can change a manager’s role', !!rowFor('mgr@geodis.com').querySelector('[data-user-role]'));
  t('your own row is not editable', !rowFor('admin@geodis.com').querySelector('[data-user-role]'));
  t('and says so', rowFor('admin@geodis.com').textContent.indexOf('This is you') !== -1);
  const initialMarketSelect = rowFor('mgr@geodis.com').querySelector('[data-user-markets-multi]');
  t('markets use an explicit multi-select', !!initialMarketSelect && initialMarketSelect.multiple);
  t('the saved market is selected', Array.from(initialMarketSelect.selectedOptions)
    .map(o => o.value).join() === 'Chicago');

  const roleSel = rowFor('mgr@geodis.com').querySelector('[data-user-role]');
  roleSel.value = 'viewer';
  roleSel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  let post = posts.filter(p => p.url && p.url.indexOf('users=1') !== -1).pop();
  t('the role change is saved', post.body.role === 'viewer');
  t('keyed by email', post.body.id === 'mgr@geodis.com');

  const setMarkets = async values => {
    // Re-query: every save re-renders, so a node held across one is detached
    // and its events never reach the delegated listener.
    const el = rowFor('mgr@geodis.com').querySelector('[data-user-markets-multi]');
    Array.from(el.options).forEach(o => { o.selected = values.indexOf(o.value) !== -1; });
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle(60);
    return posts.filter(p => p.url && p.url.indexOf('users=1') !== -1).pop();
  };
  post = await setMarkets(['Chicago']);
  t('named markets save as a list', JSON.stringify(post.body.markets) === '["Chicago"]');
  post = await setMarkets(['__all__']);
  t('the explicit All option means every authorized market', JSON.stringify(post.body.markets) === '[]');

  click(rowFor('temp@employbridge.com').querySelector('[data-user-toggle]'));
  await settle(60);
  post = posts.filter(p => p.body && p.body.enabled !== undefined).pop();
  t('a disabled account can be re-enabled', post.body.enabled === true);

  console.log('— locations —');
  click($('[data-settings-tab="locations"]'));
  await settle(60);
  t('the stored location is listed', !!rowFor('Lego Main'));
  t('the list stays scan-friendly until Edit is chosen', $$('[data-list-field]').length === 0 &&
    !!rowFor('Lego Main').querySelector('[data-list-edit]'));
  t('an add button is offered', !!$('[data-list-add="locations"]'));
  const locationPostsBeforeAdd = posts.filter(p => p.url && p.url.indexOf('locations=1') !== -1).length;
  click($('[data-list-add="locations"]'));
  const locationForm = $('[data-admin-list-form="locations"]');
  t('adding opens a draft instead of writing an empty row', !!locationForm &&
    posts.filter(p => p.url && p.url.indexOf('locations=1') !== -1).length === locationPostsBeforeAdd);
  locationForm.querySelector('[name="code"]').value = '1502';
  locationForm.querySelector('[name="name"]').value = 'Second Site';
  locationForm.querySelector('[name="market"]').value = 'Chicago';
  locationForm.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(60);
  post = posts.filter(p => p.url && p.url.indexOf('locations=1') !== -1).pop();
  t('submitting writes a complete new row', !!post.body.id && post.body.code === '1502' &&
    post.body.name === 'Second Site' && post.body.market === 'Chicago');
  t('starting active', post.body.active === true);

  click(rowFor('Lego Main').querySelector('[data-list-edit]'));
  const editLocationForm = $('[data-admin-list-form="locations"]');
  t('Edit opens the existing record as a draft', editLocationForm.querySelector('[name="code"]').value === '1519' &&
    editLocationForm.querySelector('[name="name"]').value === 'Lego Main');
  editLocationForm.querySelector('[name="name"]').value = 'Lego HQ';
  editLocationForm.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(60);
  post = posts.filter(p => p.url && p.url.indexOf('locations=1') !== -1).pop();
  t('saving the draft updates the intended record', post.body.id === 'LOC1' && post.body.name === 'Lego HQ');

  console.log('— shifts —');
  click($('[data-settings-tab="shifts"]'));
  await settle(60);
  t('the stored shift is listed', !!rowFor('A shift'));
  t('it says these supplement the workbook', d.body.textContent.indexOf('supplement') !== -1);

  console.log('— RC links —');
  click($('[data-settings-tab="links"]'));
  await settle(60);
  t('a base URL field is offered', !!$('[data-app-config="rcBaseUrl"]'));
  t('and the assignment object', !!$('[data-app-config="rcAssignmentObject"]'));
  t('it says no links show until a URL is set', d.body.textContent.indexOf('No base URL set') !== -1);
  const urlField = $('[data-app-config="rcBaseUrl"]');
  const configPostsBeforeChange = posts.filter(p => p.url && p.url.indexOf('appConfig=1') !== -1).length;
  urlField.value = 'https://acme.lightning.force.com/';
  urlField.dispatchEvent(new w.Event('change', { bubbles: true }));
  t('editing a setting stays local until Save', posts.filter(p => p.url &&
    p.url.indexOf('appConfig=1') !== -1).length === configPostsBeforeChange);
  $('[data-app-config-form]').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(60);
  post = posts.filter(p => p.url && p.url.indexOf('appConfig=1') !== -1 &&
    p.body.key === 'rcBaseUrl').pop();
  t('the URL is saved', post.body.value === 'https://acme.lightning.force.com/');
  t('under a stable id', post.body.id === 'CFG-rcBaseUrl');
  t('with the key', post.body.key === 'rcBaseUrl');

  /* A manager staffs their own team. That is the whole reason 'roles' is a
     separate permission from 'admin': they can hand out roles without also
     getting the RC base URL and the domain allowlist. */
  console.log('— a manager can staff the team, and nothing else —');
  signInAs({ email: 'mgr@geodis.com', name: 'A Manager', role: 'manager', enabled: true, markets: [] });
  await settle(40);
  t('Locations and Shifts are not even offered', !$('[data-settings-tab="locations"]') &&
    !$('[data-settings-tab="shifts"]'));
  t('nor RC links', !$('[data-settings-tab="links"]'));
  t('Users is', !!$('[data-settings-tab="users"]'));
  click($('[data-settings-tab="users"]'));
  await settle(60);
  t('a colleague’s role can be changed', !!rowFor('col@geodis.com').querySelector('[data-user-role]'));
  t('but not an admin’s', !rowFor('admin@geodis.com').querySelector('[data-user-role]'));
  t('and not their own', !rowFor('mgr@geodis.com').querySelector('[data-user-role]'));
  const mgrRoles = Array.from(rowFor('col@geodis.com')
    .querySelector('[data-user-role]').options).filter(o => !o.disabled).map(o => o.value);
  t('the roles offered stop at Manager', mgrRoles.indexOf('admin') === -1);
  t('and include Colleague and Manager',
    mgrRoles.indexOf('colleague') !== -1 && mgrRoles.indexOf('manager') !== -1);
  t('the ceiling is stated in words', /up to <b>Manager<\/b>/.test(d.body.innerHTML));

  console.log('— a colleague cannot reach any of it —');
  signInAs({ email: 'col@geodis.com', name: 'A Colleague', role: 'colleague', enabled: true, markets: [] });
  await settle(40);
  t('Users is not offered', !$('[data-settings-tab="users"]'));
  t('nor Locations', !$('[data-settings-tab="locations"]'));
  t('Connections still is — that is day-to-day work', !!$('[data-settings-tab="connections"]'));
  t('and it explains why', /needs a manager or an administrator/i.test(d.body.textContent));

  console.log('— a disabled admin is not an admin —');
  signInAs({ email: 'admin@geodis.com', name: 'The Admin', role: 'admin', enabled: false, markets: [] });
  await settle(40);
  t('and does not get into the app at all', $$('.suite-nav-btn').length === 0);
  t('being told the account was switched off', /disabled/i.test(d.body.textContent));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
