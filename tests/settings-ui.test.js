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
['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js',
 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'suite.js']
  .forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = ms => new Promise(r => setTimeout(r, ms));
const rowFor = n => $$('.suite-table tbody tr').find(tr => tr.textContent.indexOf(n) !== -1);
const signInAs = acct => w.__setAuth({ signedIn: true, email: acct.email, account: acct });

(async () => {
  await settle(60);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));

  console.log('— the page exists —');
  t('Settings is in the sidebar', !!$('[data-nav="settings"]'));
  click($('[data-nav="settings"]'));
  t('five sections', $$('[data-settings-tab]').length === 5);
  t('including RC links', !!$('[data-settings-tab="links"]'));
  t('opens on Account', $('[data-settings-tab="account"]').className.indexOf('primary') !== -1);

  console.log('— signed out —');
  t('a sign-in form is offered', !!$('[data-signin]'));
  t('with email and password', !!$('[name="email"]') && !!$('[name="password"]'));
  t('create account is offered', !!$('[data-signin-do="create"]'));
  t('so is a password reset', !!$('[data-signin-do="reset"]'));
  t('the approved domains are named',
    d.body.textContent.indexOf('geodis.com') !== -1 && d.body.textContent.indexOf('employbridge.com') !== -1);
  t('and it says a new account starts as a viewer', d.body.textContent.indexOf('starts as a viewer') !== -1);

  console.log('— signed in as an admin —');
  signInAs({ email: 'admin@geodis.com', name: 'The Admin', role: 'admin', enabled: true, markets: [] });
  await settle(20);
  t('shows who you are', d.body.textContent.indexOf('admin@geodis.com') !== -1);
  t('and your role', d.body.textContent.indexOf('Administrator') !== -1);
  t('markets default to all', d.body.textContent.indexOf('All markets') !== -1);
  t('sign out is offered', !!$('[data-sign-out]'));
  t('it is honest that sign-in is not enforced', d.body.textContent.indexOf('not enforced') !== -1);

  console.log('— users —');
  click($('[data-settings-tab="users"]'));
  await settle(60);
  t('all three accounts listed', $$('.suite-table tbody tr').length === 3);
  t('the disabled one is shown as such', rowFor('temp@employbridge.com').textContent.indexOf('Disable') !== -1 ||
    rowFor('temp@employbridge.com').textContent.indexOf('Enable') !== -1);
  t('an admin can change a manager’s role', !!rowFor('mgr@geodis.com').querySelector('[data-user-role]'));
  t('your own row is not editable', !rowFor('admin@geodis.com').querySelector('[data-user-role]'));
  t('and says so', rowFor('admin@geodis.com').textContent.indexOf('This is you') !== -1);
  t('markets show as a list', rowFor('mgr@geodis.com').querySelector('[data-user-markets]').value === 'Chicago');

  const roleSel = rowFor('mgr@geodis.com').querySelector('[data-user-role]');
  roleSel.value = 'viewer';
  roleSel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  let post = posts.filter(p => p.url && p.url.indexOf('users=1') !== -1).pop();
  t('the role change is saved', post.body.role === 'viewer');
  t('keyed by email', post.body.id === 'mgr@geodis.com');

  const setMarkets = async v => {
    // Re-query: every save re-renders, so a node held across one is detached
    // and its events never reach the delegated listener.
    const el = rowFor('mgr@geodis.com').querySelector('[data-user-markets]');
    el.value = v;
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle(60);
    return posts.filter(p => p.url && p.url.indexOf('users=1') !== -1).pop();
  };
  post = await setMarkets('Chicago, St. Louis');
  t('markets save as a list', JSON.stringify(post.body.markets) === '["Chicago","St. Louis"]');
  post = await setMarkets('');
  t('blank means every market', JSON.stringify(post.body.markets) === '[]');

  click(rowFor('temp@employbridge.com').querySelector('[data-user-toggle]'));
  await settle(60);
  post = posts.filter(p => p.body && p.body.enabled !== undefined).pop();
  t('a disabled account can be re-enabled', post.body.enabled === true);

  console.log('— locations —');
  click($('[data-settings-tab="locations"]'));
  await settle(60);
  const fieldValues = () => $$('[data-list-field]').map(i => i.value);
  t('the stored location is listed', fieldValues().indexOf('Lego Main') !== -1);
  t('as an editable field, since we are an admin', $$('[data-list-field]').length > 0);
  t('an add button is offered', !!$('[data-list-add="locations"]'));
  click($('[data-list-add="locations"]'));
  await settle(60);
  post = posts.filter(p => p.url && p.url.indexOf('locations=1') !== -1).pop();
  t('adding writes a new row', !!post.body.id);
  t('starting active', post.body.active === true);
  const field = $('[data-list-field]');
  field.value = '1502';
  field.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  post = posts.filter(p => p.url && p.url.indexOf('locations=1') !== -1).pop();
  t('editing a field saves just that field', post.body.code === '1502' || post.body.name === '1502');

  console.log('— shifts —');
  click($('[data-settings-tab="shifts"]'));
  await settle(60);
  t('the stored shift is listed', $$('[data-list-field]').map(i => i.value).indexOf('A shift') !== -1);
  t('it says these supplement the workbook', d.body.textContent.indexOf('supplement') !== -1);

  console.log('— RC links —');
  click($('[data-settings-tab="links"]'));
  await settle(60);
  t('a base URL field is offered', !!$('[data-app-config="rcBaseUrl"]'));
  t('and the assignment object', !!$('[data-app-config="rcAssignmentObject"]'));
  t('it says no links show until a URL is set', d.body.textContent.indexOf('No base URL set') !== -1);
  const urlField = $('[data-app-config="rcBaseUrl"]');
  urlField.value = 'https://acme.lightning.force.com/';
  urlField.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  post = posts.filter(p => p.url && p.url.indexOf('appConfig=1') !== -1).pop();
  t('the URL is saved', post.body.value === 'https://acme.lightning.force.com/');
  t('under a stable id', post.body.id === 'CFG-rcBaseUrl');
  t('with the key', post.body.key === 'rcBaseUrl');

  console.log('— a non-admin cannot change anything —');
  signInAs({ email: 'mgr@geodis.com', name: 'A Manager', role: 'manager', enabled: true, markets: [] });
  await settle(40);
  click($('[data-settings-tab="users"]'));
  await settle(60);
  t('no role dropdowns', $$('[data-user-role]').length === 0);
  t('no enable/disable buttons', $$('[data-user-toggle]').length === 0);
  click($('[data-settings-tab="locations"]'));
  await settle(40);
  t('no add button', !$('[data-list-add="locations"]'));
  t('no editable fields', $$('[data-list-field]').length === 0);
  t('and it explains why', d.body.textContent.indexOf('needs an administrator') !== -1);

  console.log('— a disabled admin is not an admin —');
  signInAs({ email: 'admin@geodis.com', name: 'The Admin', role: 'admin', enabled: false, markets: [] });
  await settle(40);
  click($('[data-settings-tab="users"]'));
  await settle(60);
  t('no controls for a disabled admin', $$('[data-user-role]').length === 0);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
