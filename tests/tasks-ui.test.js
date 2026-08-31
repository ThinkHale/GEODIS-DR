/* The tasks page and the + button, in a DOM.

   What matters here is the funnelling: a pending PTO request and an open
   payroll discrepancy have to appear in the queue without being copied into it,
   and marking somebody Terminated on the on-premise check has to leave a task
   behind that outlives the page. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const p2 = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
const TODAY = iso(new Date());
const ago = h => new Date(Date.now() - h * 3600000).toISOString();

const records = [
  { badge: 'b1', person: 'Ann Reed', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '1/2/2026' },
  { badge: 'b2', person: 'Ben Ortiz', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '1/3/2026' }
];
// One waiting, one already approved. Only the first is work.
const timeOff = [
  { id: 'TO1', badge: 'b1', name: 'Ann Reed', type: 'PTO', start: '2026-09-01', end: '2026-09-02',
    status: 'Received', submittedAt: ago(60) },
  { id: 'TO2', badge: 'b2', name: 'Ben Ortiz', type: 'PTO', start: '2026-09-05', status: 'Approved', submittedAt: ago(60) }
];
const discrepancies = [
  { id: 'D1', badge: 'b2', name: 'Ben Ortiz', details: 'Eight hours missing on Tuesday',
    weekEnding: '2026-08-22', status: 'Received', submittedAt: ago(9) }
];
let tasks = [];
/* Ben is scheduled across the whole day and not on the clock, so he is an
   exception -- which is what puts a disposition control on his row. */
const shiftTags = [
  { id: 's1', name: 'Ortiz, Ben', nameKey: 'ben ortiz', shift: '1st', building: '1523',
    hours: '12am-11:59pm Sun-Sat', source: 'PLX workbook' }
];
const onPremAoa = [
  ['Employee Full Name & ID', 'On Premises', 'Primary location (path)', 'Reports To'],
  ['Ortiz, Ben (80-BORTIZ2)', 'false', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1523/1523', 'Boss, B'],
  ['Reed, Ann (80-AREED1)', 'true', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1523/1523', 'Boss, B']
];

const posts = [];
let documented = {};
const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>h</header><main id="recon-main"><div id="tbody">R</div></main></body></html>`,
  { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
w.alert = m => posts.push({ alert: m });
w.confirm = () => true;
w.scrollTo = () => {};
w.prompt = () => 'Tester';
let nextAoa = onPremAoa;
w.XLSX = { read: () => ({ SheetNames: ['s'], Sheets: { s: {} } }), utils: { sheet_to_json: () => nextAoa } };
w.fetch = (url, opt) => {
  const u = String(url);
  if (opt && opt.method === 'POST') {
    const body = JSON.parse(opt.body);
    posts.push({ url: u, body });
    if (u.indexOf('tasks=1') !== -1) {
      tasks = tasks.filter(x => x.id !== body.id).concat([body]);
    }
    if (u.indexOf('coverage=1') !== -1 && body.document) documented[body.document.key] = body.document;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, record: body }) });
  }
  if (u.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (u.indexOf('schedule=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ periods: [] }) });
  if (u.indexOf('coverage=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ coverage: { documented }, dates: [] }) });
  if (u.indexOf('tasks=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ tasks }) });
  if (u.indexOf('timeoff=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ timeOff }) });
  if (u.indexOf('discrepancies=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ discrepancies }) });
  if (u.indexOf('shifts=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ shifts: shiftTags }) });
  const k = u.match(/\?(\w+)=1/)[1];
  const map = { attendance: 'attendance', requisitions: 'requisitions', performance: 'performance',
    associatePto: 'associatePto', locations: 'locations', appConfig: 'appConfig',
    timeclockLinks: 'timeclockLinks' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: [] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js',
 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js', 'contacts-core.js', 'reqs-core.js', 'suite.js']
  .forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = ms => new Promise(r => setTimeout(r, ms));
const upload = (kind, aoa, name) => {
  nextAoa = aoa;
  const input = d.querySelector('[data-cov="' + kind + '"]');
  Object.defineProperty(input, 'files', { value: [new w.File([new Uint8Array([1])], name)], configurable: true });
  input.dispatchEvent(new w.Event('change', { bubbles: true }));
};

(async () => {
  await settle(80);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));

  console.log('— the + button is on every page —');
  t('it is in the top bar', !!$('.suite-add'));
  const seen = [];
  ['overview', 'associates', 'coverage', 'attendance', 'timeoff', 'payroll', 'tasks'].forEach(v => {
    click($('[data-nav="' + v + '"]'));
    seen.push(!!$('.suite-add'));
  });
  t('on all of them', seen.every(Boolean));
  t('and next to the user block',
    $('.suite-add').nextElementSibling && $('.suite-add').nextElementSibling.classList.contains('suite-user'));

  console.log('— work funnels in without being copied —');
  click($('[data-nav="tasks"]'));
  const txt = () => d.body.textContent;
  t('the waiting PTO request appears', txt().indexOf('Ann Reed') !== -1);
  t('the approved one does not -- that is history', txt().indexOf('Ben Ortiz') !== -1);
  t('the payroll discrepancy appears', txt().indexOf('Eight hours missing') !== -1);
  t('nothing was written to make them appear',
    !posts.some(p => p.url && p.url.indexOf('tasks=1') !== -1));
  t('a derived row offers no status dropdown, because it is owned elsewhere',
    $$('tbody tr').filter(r => r.textContent.indexOf('Eight hours missing') !== -1)
      .every(r => !r.querySelector('.status-select')));
  t('it offers a way to the page that owns it instead',
    $$('tbody tr').some(r => r.textContent.indexOf('Eight hours missing') !== -1 &&
      r.querySelector('[data-nav="payroll"]')));

  console.log('— escalation —');
  t('the 60-hour PTO request is urgent', /Ann Reed[\s\S]{0,400}?Urgent/.test(txt()));
  t('the 9-hour payroll issue is urgent too, on its own four-hour rule',
    /Eight hours missing[\s\S]{0,400}?Urgent/.test(txt()) ||
    /Urgent[\s\S]{0,400}?Eight hours missing/.test(txt()));
  t('the count on the + button is the urgent one', $('.suite-add-count').textContent === '2');
  t('and the banner explains both windows',
    txt().indexOf('Payroll issues escalate after 4 hours') !== -1 &&
    txt().indexOf('everything else after 48') !== -1);

  console.log('— raising one by hand —');
  click($('.suite-add'));
  t('a form opens', !!$('[data-form="task"]'));
  const form = $('[data-form="task"]');
  form.querySelector('[name="title"]').value = 'Add Ann to Beeline';
  form.querySelector('[name="kind"]').value = 'Add to a system';
  form.querySelector('[name="badge"]').value = 'b1';
  form.querySelector('[name="detail"]').value = 'Never got a Beeline record';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(80);
  const made = posts.filter(p => p.url && p.url.indexOf('tasks=1') !== -1).pop();
  t('it is saved to the shared store', !!made);
  t('with the kind key, not the label somebody clicked', made.body.kind === 'system');
  t('open', made.body.status === 'Open');
  t('attributed', made.body.createdBy === 'Tester');
  t('and carrying the associate it is about', made.body.badge === 'b1' && made.body.name === 'Ann Reed');
  click($('[data-nav="tasks"]'));
  await settle(40);
  t('it shows on the page', d.body.textContent.indexOf('Add Ann to Beeline') !== -1);

  console.log('— a task with no description is refused —');
  click($('.suite-add'));
  const f2 = $('[data-form="task"]');
  f2.querySelector('[name="title"]').value = '   ';
  const writesBefore = posts.filter(p => p.url && p.url.indexOf('tasks=1') !== -1).length;
  f2.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(40);
  t('nothing was saved',
    posts.filter(p => p.url && p.url.indexOf('tasks=1') !== -1).length === writesBefore);
  t('and it says why', posts.some(p => p.alert && p.alert.indexOf('what has to be done') !== -1));
  if ($('[data-close]')) click($('[data-close]'));

  console.log('— marking somebody Terminated leaves a task behind —');
  click($('[data-nav="coverage"]'));
  upload('presence', onPremAoa, 'On Premise - Simple_' + TODAY + 'T09_00_00.000.csv');
  await settle(120);
  const disp = $('.cov-disp');
  t('the absent person has a disposition control', !!disp);
  const beforeTasks = tasks.length;
  disp.value = 'Terminated';
  disp.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(140);
  t('a task was raised', tasks.length === beforeTasks + 1);
  const term = tasks[tasks.length - 1];
  t('naming the person', term.title.indexOf('Ben Ortiz') !== -1);
  t('and what has to happen', term.title.indexOf('End the assignment') !== -1);
  t('with the detail saying where it came from', term.detail.indexOf('on-premise check') !== -1);
  t('and that both systems need it', term.detail.indexOf('RC and Beeline') !== -1);
  t('it is a terminate task', term.kind === 'terminate');
  t('it starts open, so it persists until somebody finishes it', term.status === 'Open');

  // Re-picking it must not grow a pile of identical tasks.
  const again = $('.cov-disp');
  again.value = 'Called in';
  again.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(120);
  const back = $('.cov-disp');
  back.value = 'Terminated';
  back.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(120);
  t('documenting the same person twice does not raise a second task',
    tasks.filter(x => x.kind === 'terminate').length === 1);
  t('and switching away does not delete it -- somebody may be working it',
    tasks.some(x => x.kind === 'terminate'));

  console.log('— completing one —');
  click($('[data-nav="tasks"]'));
  await settle(60);
  const termId = tasks.filter(x => x.kind === 'terminate')[0].id;
  const doneBtn = $$('[data-task-done]').filter(b => b.dataset.taskDone === termId)[0];
  t('a stored task offers a one-click Complete', !!doneBtn);
  t('a derived one does not -- it is finished on the page that owns it',
    $$('[data-task-done]').length < $$('tbody tr').length);
  click(doneBtn);
  await settle(80);
  const term2 = tasks.filter(x => x.id === termId)[0];
  t('it is marked complete', term2.status === 'Complete');
  t('and stays on file rather than being deleted', tasks.some(x => x.id === termId));
  t('the change is attributed', term2.statusUpdatedBy === 'Tester');
  t('its updatedAt moved, so working a task stops it escalating',
    term2.updatedAt === term2.statusUpdatedAt);
  click($('[data-nav="tasks"]'));
  await settle(40);
  t('it drops out of the open queue',
    !$$('tbody tr').some(r => r.textContent.indexOf('End the assignment') !== -1));
  const doneToggle = $('#task-done');
  doneToggle.checked = true;
  doneToggle.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(40);
  t('but Show completed brings it back',
    $$('tbody tr').some(r => r.textContent.indexOf('End the assignment') !== -1));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
