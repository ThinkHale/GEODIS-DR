/* A pull that lands before the schedule does.

   The on-premise export is dropped several times a day; the schedule it is
   compared against comes from the PLX workbook's shift tags, which are loaded
   from the server. When the tags are not there yet -- still loading, or never
   imported -- there is nothing to compare the pull against.

   It must not be thrown away. Returning quietly is what made a daily upload
   look like it had worked and store nothing at all. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const onPremAoa = [
  ['Employee Full Name & ID', 'On Premises', 'Primary location', 'Reports To'],
  ['Grachen, Luz (80-LGRACH3897)', 'true', 'GEODIS/US/CL/CLSCEN/CLSL/CL1502/1502', 'Pickett, Craig'],
  ['Porras, Fernando (80-FPORRA4387)', 'false', 'GEODIS/US/CL/CLSCEN/CLSL/CL1502/1502', 'Pickett, Craig']
];
const records = [
  { badge: '80-LGRACH3897', person: 'Luz Grachen', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago' },
  { badge: '80-FPORRA4387', person: 'Fernando Porras', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago' }
];
const shiftTags = [
  { id: 'eid:80-LGRACH3897', eid: '80-LGRACH3897', name: 'Grachen, Luz', nameKey: 'grachen luz',
    shift: '1st', building: '1502', hours: '6am-2:30pm Mon-Fri', source: 'PLX workbook' },
  { id: 'eid:80-FPORRA4387', eid: '80-FPORRA4387', name: 'Porras, Fernando', nameKey: 'fernando porras',
    shift: '1st', building: '1502', hours: '6am-2:30pm Mon-Fri', source: 'PLX workbook' }
];

// The workbook has not been imported yet, so the server has no shift tags.
let servedShifts = [];
const posts = [];
let storedDay = {};
const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>legacy</header><main id="recon-main"><div id="tbody">R</div></main>
</body></html>`, { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;

let nextAoa = onPremAoa;
w.XLSX = { read: () => ({ SheetNames: ['s'], Sheets: { s: {} } }), utils: { sheet_to_json: () => nextAoa } };
w.alert = m => posts.push({ alert: m });
w.confirm = () => true;
w.scrollTo = () => {};
w.fetch = (url, opt) => {
  const u = String(url);
  if (opt && opt.method === 'POST') {
    const body = JSON.parse(opt.body);
    posts.push({ url: u, body });
    if (u.indexOf('coverage=1') !== -1 && body.check) {
      storedDay.checks = (storedDay.checks || []).concat([body.check]);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  }
  if (u.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (u.indexOf('schedule=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ schedule: {} }) });
  if (u.indexOf('coverage=1') !== -1) {
    const payload = u.indexOf('date=') !== -1 ? { coverage: storedDay } : { dates: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
  }
  if (u.indexOf('shifts=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ shifts: servedShifts }) });
  const k = u.match(/\?(\w+)=1/)[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions', performance: 'performance', discrepancies: 'discrepancies' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: [] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js',
 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js', 'contacts-core.js',
 'reqs-core.js', 'pto-tracker-core.js', 'suite.js'].forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s);
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = ms => new Promise(r => setTimeout(r, ms));
const checkPosts = () => posts.filter(p => p.url && p.url.indexOf('coverage=1') !== -1 && p.body && p.body.check);

(async () => {
  await settle(40);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));
  click($('[data-nav="coverage"]'));

  console.log('— a pull with no schedule to compare it against —');
  nextAoa = onPremAoa;
  const input = d.querySelector('[data-cov="presence"]');
  Object.defineProperty(input, 'files', {
    value: [new w.File([new Uint8Array([1])], 'On Premise - Simple_2026-08-25T09_00_00.csv')],
    configurable: true
  });
  input.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(80);

  t('nothing is stored yet, because nothing can be compared', checkPosts().length === 0);
  // The failure this replaces was silence: the page looked exactly as it does
  // before any file is chosen, so the same upload was repeated day after day.
  t('the page says the pull is being held', d.body.textContent.indexOf('Holding') !== -1);
  t('and names the file it is holding',
    d.body.textContent.indexOf('On Premise - Simple_2026-08-25T09_00_00.csv') !== -1);
  t('and says it is not stored', d.body.textContent.indexOf('not stored yet') !== -1);
  t('and says what would unblock it', d.body.textContent.indexOf('PLX workbook') !== -1);

  console.log('— the workbook arrives, and the held pull files itself —');
  servedShifts = shiftTags;
  click($('[data-refresh]'));
  await settle(120);

  const stored = checkPosts().pop();
  t('the held pull was stored without a second upload', !!stored);
  // So a regression reports every assertion below rather than a stack trace.
  const chk = stored || { url: '', body: { check: { exceptions: [], rows: [] } } };
  t('filed under the as-of from its own file name', chk.url.indexOf('date=2026-08-25') !== -1);
  t('with the as-of it was captured at', chk.body.check.asOf === '2026-08-25T09:00:00');
  t('the absent person is still an exception',
    chk.body.check.exceptions.some(e => e.name === 'Porras, Fernando'));
  t('and the full report went with it', (chk.body.check.rows || []).length === 2);
  t('only once', checkPosts().length === 1);
  t('the holding note is gone', d.body.textContent.indexOf('Holding') === -1);
  t('replaced by confirmation it stuck', d.body.textContent.indexOf('Saved and shared') !== -1);

  /* What the holding note actually tells somebody to do is import the workbook,
     and the place to do that is this page -- not the refresh button. That upload
     swapped the stores in without going through applyStores(), so the pull sat
     there held until the tab closed and took it with it. */
  console.log('— the workbook is imported from this page, and the held pull files itself —');
  servedShifts = [];
  click($('[data-refresh]'));
  await settle(120);
  const later = d.querySelector('[data-cov="presence"]');
  Object.defineProperty(later, 'files', {
    value: [new w.File([new Uint8Array([1])], 'On Premise - Simple_2026-08-26T09_00_00.csv')],
    configurable: true
  });
  later.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(80);
  const filedFor = date => checkPosts().filter(p => p.url.indexOf('date=' + date) !== -1);
  t('the second pull is held too', d.body.textContent.indexOf('Holding') !== -1 &&
    filedFor('2026-08-26').length === 0);

  servedShifts = shiftTags;
  const book = d.querySelector('[data-cov="workbook"]');
  t('the workbook can be imported from the On-Premise page', !!book);
  if (book) {
    Object.defineProperty(book, 'files', {
      value: [new w.File([new Uint8Array([80, 75, 3, 4])], 'PLX - Geodis Spreadsheet.xlsx')],
      configurable: true
    });
    book.dispatchEvent(new w.Event('change', { bubbles: true }));
  }
  await settle(200);

  t('the workbook went to the server', posts.some(p => p.url && p.url.indexOf('plxUpload=1') !== -1));
  t('and the pull it was holding was stored', filedFor('2026-08-26').length === 1);
  t('the holding note is gone again', d.body.textContent.indexOf('Holding') === -1);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
