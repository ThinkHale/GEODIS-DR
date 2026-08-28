/* Approved PTO as it appears on the On-Premise page and on a profile. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const p2 = n => String(n).padStart(2, '0');
const d0 = new Date();
const TODAY = d0.getFullYear() + '-' + p2(d0.getMonth() + 1) + '-' + p2(d0.getDate());

const records = [
  { badge: 'b1', person: 'Ada Away', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '1/2/2026' },
  { badge: 'b2', person: 'Gus Gone', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '1/3/2026' }
];
// Ada has approved PTO today. Gus filed a request that nobody has approved.
const timeOff = [
  { id: 'T1', badge: 'b1', name: 'Ada Away', type: 'PTO', start: TODAY, end: TODAY, status: 'Approved', submittedAt: TODAY },
  { id: 'T2', badge: 'b2', name: 'Gus Gone', type: 'PTO', start: TODAY, end: TODAY, status: 'Received', submittedAt: TODAY }
];
// Both were logged an absence for today, before the PTO was looked at.
const attendance = [
  { id: 'A1', badge: 'b1', date: TODAY, type: 'Absent', points: 1, notes: 'no show' },
  { id: 'A2', badge: 'b2', date: TODAY, type: 'Absent', points: 1, notes: 'no show' }
];
const shiftTags = [
  { id: 's1', name: 'Away, Ada', nameKey: 'ada away', shift: '1st', building: '1523', hours: '12am-11:59pm Sun-Sat', source: 'PLX workbook' },
  { id: 's2', name: 'Gone, Gus', nameKey: 'gone gus', shift: '1st', building: '1523', hours: '12am-11:59pm Sun-Sat', source: 'PLX workbook' }
];
const onPremAoa = [
  ['Employee Full Name & ID', 'On Premises', 'Primary location (path)', 'Reports To'],
  ['Away, Ada (80-AAWAY1)', 'false', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1523/1523', 'Boss, B'],
  ['Gone, Gus (80-GGONE2)', 'false', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1523/1523', 'Boss, B']
];

const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>h</header><main id="recon-main"><div id="tbody">R</div></main></body></html>`,
  { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
let nextAoa = onPremAoa;
w.XLSX = { read: () => ({ SheetNames: ['s'], Sheets: { s: {} } }), utils: { sheet_to_json: () => nextAoa } };
w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {}; w.prompt = () => 'Tester';
w.fetch = (url, opt) => {
  const u = String(url);
  if (opt && opt.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  if (u.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (u.indexOf('schedule=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ periods: [] }) });
  if (u.indexOf('coverage=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ coverage: {}, dates: [] }) });
  if (u.indexOf('shifts=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ shifts: shiftTags }) });
  if (u.indexOf('timeoff=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ timeOff }) });
  if (u.indexOf('attendance=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ attendance }) });
  const k = u.match(/\?(\w+)=1/)[1];
  const map = { requisitions: 'requisitions', performance: 'performance', discrepancies: 'discrepancies',
    associatePto: 'associatePto', locations: 'locations', appConfig: 'appConfig', timeclockLinks: 'timeclockLinks', tasks: 'tasks' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: [] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js',
 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js', 'suite.js']
  .forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = ms => new Promise(r => setTimeout(r, ms));
const rowFor = name => $$('.cov-row').filter(r => r.textContent.indexOf(name) !== -1)[0];

(async () => {
  await settle(80);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));
  click($('[data-nav="coverage"]'));
  const input = d.querySelector('[data-cov="presence"]');
  Object.defineProperty(input, 'files', { value: [new w.File([new Uint8Array([1])], 'On Premise - Simple_' + TODAY + 'T09_00_00.000.csv')], configurable: true });
  input.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(140);
  $('#cov-status').value = 'all';
  $('#cov-status').dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);

  console.log('— the floor —');
  const ada = rowFor('Away, Ada'), gus = rowFor('Gone, Gus');
  t('the approved absence reads as On PTO', ada && ada.textContent.indexOf('On PTO') !== -1);
  t('and says what covers it', ada.textContent.indexOf('PTO approved') !== -1);
  t('it is not an exception', !ada.classList.contains('bad'));
  t('so no disposition control is offered on it', !ada.querySelector('.cov-disp'));
  t('the unapproved absence is still not clocked in', gus.textContent.indexOf('Not clocked in') !== -1);
  t('still an exception', gus.classList.contains('bad'));
  t('and still asks to be explained', !!gus.querySelector('.cov-disp'));
  t('the metric strip reports the PTO', d.body.textContent.indexOf('On PTO') !== -1);

  console.log('— the ledger —');
  click($('[data-nav="associates"]'));
  click($('[data-profile="b1"]'));
  await settle(40);
  const txt = d.body.textContent;
  t('the occurrence is still listed', txt.indexOf('no show') !== -1);
  t('with a note saying PTO cleared it', txt.indexOf('PTO approved for this day') !== -1);
  t('the original value is shown struck through', !!$('.pts-void'));
  t('and the point total is zero', /Attendance points[\s\S]{0,80}?>0</.test(d.body.innerHTML));

  click($('[data-nav="associates"]'));
  click($('[data-profile="b2"]'));
  await settle(40);
  t('the unapproved one still carries its point',
    /Attendance points[\s\S]{0,80}?>1</.test(d.body.innerHTML));
  t('and is not marked as cleared', !$('.pts-void'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
