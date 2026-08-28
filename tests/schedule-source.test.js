/* Which schedule the on-premise page is actually using.

   The workbook says who works which shift, and it is uploaded daily. A WFM
   schedule export is uploaded rarely, if ever, and the server keeps the last
   one. If the stored export quietly wins, the floor is measured against a
   roster that may be days stale -- people who have since left the agency
   workbook keep showing as "scheduled", and people added since are invisible.
   The workbook is the default; an export overrides it only when someone
   deliberately drops one in. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const p2 = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
const TODAY = iso(new Date());
const weekStart = (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay()); return iso(d); })();
const weekEnd = (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay() + 6); return iso(d); })();
const allDay = { raw: '6:00 AM - 11:00 PM', start: 360, end: 1380, overnight: false, code: '' };

/* GHOST is on the stored WFM export but NOT in the workbook -- somebody who has
   come off the agency roster since that export was taken. REAL is on both. */
const storedWeek = {
  periodStart: weekStart, periodEnd: weekEnd, fileName: 'employee_schedule_weekly.xlsx',
  executedAt: weekStart, uploadedAt: weekStart + 'T08:00:00',
  people: [
    { name: 'Ghost, Gary', nameKey: 'ghost,gary', badge: '230968', wfmId: '',
      location: 'GEODIS/US/CL/CL1517/1517', job: 'Default', shifts: { [TODAY]: allDay } },
    { name: 'Real, Rita', nameKey: 'real,rita', badge: '111111', wfmId: '',
      location: 'GEODIS/US/CL/CL1517/1517', job: 'Default', shifts: { [TODAY]: allDay } }
  ]
};
const shiftTags = [
  { id: 'eid:80-RREAL0001', eid: '80-RREAL0001', nameKey: 'real rita', name: 'Real, Rita',
    shift: '1st', building: '1517', dept: '1517-18270', hours: '6am-11pm Sun-Sat', source: 'PLX workbook' }
];
const onPremAoa = [
  ['Employee Full Name & ID', 'On Premises', 'Primary location (path)', 'Reports To'],
  ['Real, Rita (80-RREAL0001)', 'true', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1517/1517', 'Boss, B'],
  ['Ghost, Gary (80-GGHOST0002)', 'false', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1517/1517', 'Boss, B']
];

const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>h</header><main id="recon-main"><div id="tbody">R</div></main></body></html>`,
  { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
let nextAoa = onPremAoa;
w.XLSX = { read: () => ({ SheetNames: ['s'], Sheets: { s: {} } }), utils: { sheet_to_json: () => nextAoa } };
w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {};
w.fetch = (url, opt) => {
  const u = String(url);
  if (opt && opt.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  if (u.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (u.indexOf('schedule=1&period=') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ schedule: storedWeek }) });
  if (u.indexOf('schedule=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ periods: [weekStart] }) });
  if (u.indexOf('coverage=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ coverage: {}, dates: [] }) });
  if (u.indexOf('shifts=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ shifts: shiftTags }) });
  const k = u.match(/\?(\w+)=1/)[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions', performance: 'performance', discrepancies: 'discrepancies' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: [] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js',
 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'suite.js'].forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s);
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const upload = (kind, aoa, name) => {
  nextAoa = aoa;
  const input = d.querySelector('[data-cov="' + kind + '"]');
  Object.defineProperty(input, 'files', { value: [new w.File([new Uint8Array([1])], name)], configurable: true });
  input.dispatchEvent(new w.Event('change', { bubbles: true }));
};
const settle = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await settle(80);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records: [] } }));
  click($('[data-nav="coverage"]'));
  upload('presence', onPremAoa, 'On Premise - Simple_' + TODAY + 'T09_00_00.000.csv');
  await settle(120);

  console.log('— the workbook wins over a stored WFM export —');
  const txt = () => d.body.textContent;
  t('the page says which source it used', txt().indexOf('Scheduled from the') !== -1);
  t('and names the workbook', txt().indexOf('PLX workbook') !== -1);
  t('somebody off the workbook is not reported as scheduled',
    !/Ghost, Gary[\s\S]{0,400}?scheduled/i.test(txt()));
  t('the passed-over export is disclosed, not hidden',
    txt().indexOf('stored WFM schedule') !== -1);
  t('the person on both sources is scheduled', txt().indexOf('Real, Rita') !== -1);

  /* Gary is off the workbook AND off the clock, so he is not offered as somebody
     to connect -- but he is not swept away either: he is counted in the banner
     and still listed once the table is widened past exceptions. */
  const banner = d.querySelector('.cov-unlinked').textContent;
  t('somebody off the clock is not offered for connecting',
    banner.indexOf('Ghost, Gary') === -1);
  t('but is disclosed as a count', banner.indexOf('1 more are unconnected') !== -1);
  const status = $('#cov-status');
  status.value = 'all';
  status.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(40);
  t('and is still in the table itself', d.querySelector('.suite-table').textContent.indexOf('Ghost, Gary') !== -1);
  t('reading as not scheduled', /Ghost, Gary[\s\S]{0,300}?Not scheduled/.test(d.querySelector('.suite-table').textContent));

  console.log('— an export dropped in by hand still overrides it —');
  // The real "Employee Schedule - Weekly" shape: a period header, a location
  // line, then day columns whose dates sit on the row below the day names.
  const us = x => (x.getMonth() + 1) + '/' + x.getDate() + '/' + x.getFullYear();
  const sun = new Date(); sun.setDate(sun.getDate() - sun.getDay());
  const sat = new Date(); sat.setDate(sat.getDate() - sat.getDay() + 6);
  const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
  upload('schedule', [
    ['Time Period :', '', us(sun) + ' - ' + us(sat)],
    ['GEODIS/US/CL/CLNCEN/CLCHI/CL1517/1517'],
    ['Employee', 'Primary Job', dayName],
    ['', '', us(new Date())],
    ['Ghost, Gary', 'OPR2', '6:00 AM - 11:00 PM']
  ], 'employee_schedule_weekly.xlsx');
  await settle(120);
  t('the note no longer claims the workbook', d.body.textContent.indexOf('Scheduled from the') === -1);
  t('and the hand-dropped export is what is scheduling now',
    /Ghost, Gary/.test(d.body.textContent));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
