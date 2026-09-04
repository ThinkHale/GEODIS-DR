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
  { badge: 'b2', person: 'Gus Gone', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '1/3/2026' },
  /* Nate has no contacts record at all. His number is on the RC assignment row,
     which is where RC keeps it -- captured at placement -- and it was being
     dropped, so his profile read as having no number on file. */
  { badge: 'b3', empNumber: '21407056', person: 'Nate New', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '8/25/2026', phone: '(630) 380-0838' }
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
  { id: 's2', name: 'Gone, Gus', nameKey: 'gone gus', shift: '1st', building: '1523', hours: '12am-11:59pm Sun-Sat', source: 'PLX workbook' },
  // On the roster and scheduled, but with no timeclock record at all.
  { id: 's3', name: 'New, Nate', nameKey: 'nate new', shift: '1st', building: '1523', hours: '12am-11:59pm Sun-Sat', source: 'PLX workbook' }
];
const onPremAoa = [
  ['Employee Full Name & ID', 'On Premises', 'Primary location (path)', 'Reports To'],
  ['Away, Ada (80-AAWAY1)', 'false', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1523/1523', 'Boss, B'],
  ['Gone, Gus (80-GGONE2)', 'false', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1523/1523', 'Boss, B']
];

// Gus has a number on file; Ada does not.
const contacts = [{ id: 'PH-b2', badge: 'b2', phone: '7736395639', name: 'Gus Gone',
  source: 'Entered by hand', updatedAt: TODAY }];

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
  if (u.indexOf('contacts=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ contacts }) });
  const k = u.match(/\?(\w+)=1/)[1];
  const map = { requisitions: 'requisitions', performance: 'performance', discrepancies: 'discrepancies',
    associatePto: 'associatePto', locations: 'locations', appConfig: 'appConfig', timeclockLinks: 'timeclockLinks', tasks: 'tasks' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: [] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js',
 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js', 'contacts-core.js', 'reqs-core.js', 'pto-tracker-core.js', 'suite.js']
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

  console.log('— the number, where the lookup actually happens —');
  t('the exception row carries it', gus.textContent.indexOf('(773) 639-5639') !== -1);
  t('as something you can ring', !!gus.querySelector('a[href="tel:+17736395639"]'));
  t('and copy for TextUs or Vonage', !!gus.querySelector('[data-phone-copy]'));
  t('the PTO row does not -- nobody is chasing an approved absence',
    ada.textContent.indexOf('(773)') === -1);
  t('somebody with no number on an exception row is offered the chance to add one',
    !!gus.querySelector('[data-phone-copy]') || !!gus.querySelector('[data-phone-edit]'));

  console.log('— on the roster but not in the timeclock —');
  const nate = rowFor('New, Nate');
  t('they are shown, not dropped', !!nate);
  t('and read as not in the timeclock, never as absent',
    nate.textContent.indexOf('Not in timeclock') !== -1 &&
    nate.textContent.indexOf('Not clocked in') === -1);
  t('it is a warning, not an attendance exception', !nate.classList.contains('bad'));
  t('no disposition list is offered, so no points can follow',
    !nate.querySelector('.cov-disp'));
  t('what is offered is getting them added', !!nate.querySelector('[data-add-clock]'));
  t('the page explains why they are not counted absent',
    d.body.textContent.indexOf('not been set up there yet') !== -1);

  console.log('— and the fix is one click —');
  click(nate.querySelector('[data-add-clock]'));
  await settle(40);
  const f = $('[data-form="task"]');
  t('a task form opens', !!f);
  t('already describing the job', f.querySelector('[name="title"]').value === 'Add Nate New to the timeclock');
  // The select carries the kind KEY. It used to carry the label, which is how a
  // kind somebody picked could arrive at the server as free text.
  t('as a system task', f.querySelector('[name="kind"]').value === 'system');
  t('and shows that in words', f.querySelector('[name="kind"]').selectedOptions[0].textContent === 'Add to a system');
  t('naming them by EID, which is what the team works from',
    f.querySelector('[name="detail"]').value.indexOf('21407056') !== -1);
  if ($('[data-close]')) click($('[data-close]'));
  await settle(20);

  console.log('— the ledger —');
  click($('[data-nav="associates"]'));
  click($('[data-profile="b1"]'));
  await settle(40);
  const txt = d.body.textContent;
  t('the occurrence is still listed', txt.indexOf('no show') !== -1);
  t('with a note saying PTO cleared it', txt.indexOf('PTO approved for this day') !== -1);
  t('the original value is shown struck through', !!$('.pts-void'));
  t('a profile with no number offers to add one', !!$('[data-phone-edit]'));
  t('and the point total is zero', /Attendance points[\s\S]{0,80}?>0</.test(d.body.innerHTML));

  click($('[data-nav="associates"]'));
  click($('[data-profile="b2"]'));
  await settle(40);
  t('the unapproved one still carries its point',
    /Attendance points[\s\S]{0,80}?>1</.test(d.body.innerHTML));
  t('and is not marked as cleared', !$('.pts-void'));
  t('a number typed against the badge is still the one shown',
    d.body.textContent.indexOf('(773) 639-5639') !== -1);

  console.log('— the number RC already has —');
  click($('[data-nav="associates"]'));
  click($('[data-profile="b3"]'));
  await settle(40);
  t('reaches a profile with nothing else on file',
    d.body.textContent.indexOf('(630) 380-0838') !== -1);
  t('and says where it came from', d.body.textContent.indexOf('RC assignment') !== -1);
  t('so it is dialable', !!$('a[href="tel:+16303800838"]'));
  t('and copyable for TextUs or Vonage', !!$('[data-phone-copy]'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
