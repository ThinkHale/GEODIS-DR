/* The gate: what an unauthenticated browser, and each role, can actually reach.
 *
 * auth.test.js proves the RULES. This proves the tool obeys them -- that the
 * page does not render without an account, that a read-only account is given a
 * view and no controls, and that a write attempted anyway is refused rather than
 * quietly dropped.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const records = [
  { badge: '215001', person: 'Luz Grachen', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' }
];
const stores = {
  timeOff: [{ id: 'T1', badge: '215001', name: 'Luz Grachen', type: 'PTO', start: '2026-09-02',
    end: '2026-09-02', hours: 8, status: 'Received', source: 'Form' }],
  tasks: [{ id: 'TK1', kind: 'note', title: 'Chase the badge printer', detail: '', status: 'Open',
    createdAt: '2026-09-01T08:00:00Z', updatedAt: '2026-09-01T08:00:00Z' }]
};

const posts = [], alerts = [];
const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>legacy</header><main id="recon-main"><div id="tbody">R</div></main></body></html>`,
  { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
w.alert = m => alerts.push(m); w.confirm = () => true; w.scrollTo = () => {};
w.prompt = m => { posts.push({ prompt: m }); return null; };
w.XLSX = { read: () => ({ SheetNames: [], Sheets: {} }), utils: { sheet_to_json: x => x } };
w.fetch = (u, o) => {
  const s = String(u);
  if (o && o.method === 'POST') {
    posts.push({ url: s, body: JSON.parse(o.body) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  }
  posts.push({ get: s });
  if (s.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (/schedule=1|coverage=1|payroll=1|reqSync=1|ilPto=1|snapshot=1/.test(s)) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  }
  const k = (s.match(/\?(\w+)=1/) || [])[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions',
    performance: 'performance', shifts: 'shifts', discrepancies: 'discrepancies',
    associatePto: 'associatePto', locations: 'locations', appConfig: 'appConfig',
    timeclockLinks: 'timeclockLinks', tasks: 'tasks', contacts: 'contacts', reqCandidates: 'reqCandidates' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: stores[map[k]] || [] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js',
 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js', 'contacts-core.js',
 'reqs-core.js', 'pto-tracker-core.js', 'suite.js']
  .forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = ms => new Promise(r => setTimeout(r, ms));
const setAuth = o => w.__setAuth(o);
const writes = () => posts.filter(p => p.url).length;

(async () => {
  await settle(60);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));
  await settle(40);

  /* Between load and the first answer from Firebase the honest state is "not
     known yet". Rendering the sign-in form during that gap flashes it at
     somebody already signed in, and invites a password they did not need. */
  console.log('— before the answer is known —');
  setAuth({ ready: false, signedIn: false, account: null, email: '' });
  await settle(30);
  t('no sign-in form yet', !$('[data-signin]'));
  t('and no app either', $$('.suite-nav-btn').length === 0);
  t('it says it is still checking', /checking your sign-in/i.test(d.body.textContent));

  console.log('— signed out —');
  setAuth({ ready: true, signedIn: false, account: null, email: '' });
  await settle(30);
  t('a sign-in card', !!$('[data-signin]'));
  t('no navigation', $$('.suite-nav-btn').length === 0);
  /* Each domain is escaped on its own and then joined. Escaping the JOINED
     string put a literal `</b> and <b>` on the card, in front of everyone. */
  t('the approved domains read as words, not as markup',
    /open to geodis\.com and employbridge\.com addresses/.test(
      d.body.textContent.replace(/\s+/g, ' ')));
  t('and no stray tags leaked into the text', d.body.textContent.indexOf('</b>') === -1);
  t('no roster on the page', d.body.textContent.indexOf('Luz Grachen') === -1);
  t('and no PTO either', d.body.textContent.indexOf('2026-09-02') === -1);
  /* The reconciliation tool is in the page's own markup, not in the string the
     suite renders -- so hiding it takes an explicit class. Without it the gate
     covers nothing and the whole crosscheck sits below the fold. */
  t('the legacy reconciliation markup is hidden too',
    d.body.classList.contains('suite-gated'));

  console.log('— signed in, no role yet —');
  setAuth({ ready: true, signedIn: true, email: 'new@geodis.com',
    account: { email: 'new@geodis.com', role: 'pending', enabled: true, markets: [] } });
  await settle(30);
  t('still no app', $$('.suite-nav-btn').length === 0);
  t('the account is named', d.body.textContent.indexOf('new@geodis.com') !== -1);
  t('and it says who can grant one', /manager or an administrator/i.test(d.body.textContent));
  t('with a way back out', !!$('[data-sign-out]'));

  console.log('— a disabled account —');
  setAuth({ ready: true, signedIn: true, email: 'gone@geodis.com',
    account: { email: 'gone@geodis.com', role: 'admin', enabled: false, markets: [] } });
  await settle(30);
  t('a disabled admin is not an admin', $$('.suite-nav-btn').length === 0);
  t('and is told the account was switched off', /disabled/i.test(d.body.textContent));

  console.log('— read-only —');
  w.__setRole('viewer');
  await settle(60);
  t('the app renders', $$('.suite-nav-btn').length > 0);
  const before = writes();
  click($('[data-nav="timeoff"]'));
  await settle(40);
  t('the day is visible', d.body.textContent.indexOf('Luz Grachen') !== -1);
  t('a banner says why nothing can be changed', !!$('.read-only-banner'));
  t('naming the role', /Read-only/.test($('.read-only-banner').textContent));
  t('no status controls', $$('.status-select').length === 0);
  t('nothing to remove', $$('[data-del]').length === 0);
  t('no + Task button in the header', !$('.suite-add'));
  click($('[data-nav="tasks"]'));
  await settle(40);
  t('tasks are readable', d.body.textContent.indexOf('Chase the badge printer') !== -1);
  t('but not completable', $$('[data-task-done]').length === 0);
  t('and nothing was written by looking', writes() === before);

  /* The hidden buttons are a courtesy. The refusal has to hold when a write is
     reached anyway -- and the way that really happens is a STALE RENDER: the
     page was drawn for a colleague, somebody took the role away, and the
     controls are still sitting on screen. */
  console.log('— a write on a stale render is refused, not dropped —');
  w.__setRole('colleague');
  await settle(60);
  click($('[data-nav="timeoff"]'));
  await settle(40);
  const staleSelect = $('.status-select');
  t('the control is on screen', !!staleSelect);
  // The role changes underneath, with no re-render -- so the button stays.
  w.GEODISSuite.state.auth.account = { email: 'tester@geodis.com', name: 'Tester',
    role: 'viewer', enabled: true, markets: [] };
  alerts.length = 0;
  const before2 = writes();
  staleSelect.value = 'Approved';
  staleSelect.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  t('nothing was written', writes() === before2);
  t('and it said so rather than doing nothing', alerts.length === 1);
  t('naming the role that refused it', /Read-only/.test(alerts[0]));
  t('and who can change that', /manager or an administrator/i.test(alerts[0]));

  console.log('— a colleague gets the tool back —');
  w.__setRole('colleague');
  await settle(60);
  click($('[data-nav="timeoff"]'));
  await settle(40);
  t('no read-only banner', !$('.read-only-banner'));
  t('status controls are back', $$('.status-select').length > 0);
  t('and so is the + Task button', !!$('.suite-add'));

  console.log('— the header says who you are —');
  t('the account is named in the top bar', $('.suite-user').textContent.indexOf('Tester') !== -1);
  t('with the role beside it', /Colleague/.test($('.suite-user').textContent));
  t('and sign out is always one click away', !!$('.suite-user [data-sign-out]'));

  console.log('— an admin, and only an admin, gets the settings panel —');
  w.__setRole('colleague');
  await settle(30);
  click($('[data-nav="settings"]'));
  await settle(60);
  t('a colleague sees no Users tab', !$('[data-settings-tab="users"]'));
  t('and no RC links', !$('[data-settings-tab="links"]'));
  w.__setRole('manager');
  await settle(60);
  t('a manager sees Users', !!$('[data-settings-tab="users"]'));
  t('but still no RC links', !$('[data-settings-tab="links"]'));
  w.__setRole('admin');
  await settle(60);
  t('an admin sees everything', !!$('[data-settings-tab="users"]') && !!$('[data-settings-tab="links"]'));

  /* Signed out in another tab, or a role taken away mid-session. The server says
     no; the page has to put the gate back rather than quietly stop working. */
  console.log('— refused mid-session —');
  d.dispatchEvent(new w.CustomEvent('geodis:denied', { detail: { status: 401 } }));
  await settle(40);
  t('the refusal is surfaced', /no longer signed in/i.test(d.body.textContent));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
