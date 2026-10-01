/* The Meeting Prep page: what it shows for a comparison, the window picker, the
   header's market filter, and who is offered the workbook download. */
const { JSDOM } = require('jsdom'); const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
const H = require('../plx-history-core.js');
let pass = 0, fail = 0; const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

// Two snapshots, built by hand: one start at 1502, one new order at 1536.
const before = { version: 1, roster: { 'E-1': { eid: 'E-1', name: 'Grachen, Luz', location: '1502' } },
  candidates: { 'mia ortiz': { key: 'mia ortiz', name: 'Ortiz, Mia', stage: 'pipeline', location: '1536', wtDate: '' } },
  openSlots: { 1502: 2 }, orders: {}, attendance: {} };
const after = { version: 1,
  roster: { 'E-1': before.roster['E-1'], 'E-2': { eid: 'E-2', name: 'Nuevo, Ana', location: '1502', site: '1502 - HC', shift: '1st' } },
  candidates: { 'mia ortiz': Object.assign({}, before.candidates['mia ortiz'], { wtDate: '10/2 9am' }) },
  openSlots: { 1502: 1 },
  orders: { 111000: { req: '111000', location: '1536', account: 'Redbull', openings: 4 } }, attendance: {} };
const comparison = { from: { id: 'a', takenAt: '2026-09-30T08:00:00Z' }, to: { id: 'b', takenAt: '2026-10-01T08:00:00Z' },
  partial: false, changes: H.diff(before, after) };
const uploads = [
  { id: 'a', takenAt: '2026-09-30T08:00:00Z', fileName: 'PLX.xlsx', via: 'push', changes: null },
  { id: 'b', takenAt: '2026-10-01T08:00:00Z', fileName: 'PLX.xlsx', uploadedBy: 'Cody', via: 'upload', changes: comparison.changes.counts }
];
const asked = [];

function boot(url) {
const dom = new JSDOM('<!doctype html><html><body class="suite-active"><div id="suite-root"></div></body></html>',
  { runScripts: 'outside-only', url: url });
const w = dom.window;
w.fetch = (url) => {
  url = String(url);
  if (/plxChanges=1/.test(url)) {
    asked.push(url);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(
      { ok: true, retentionDays: 7, uploads, comparison }) });
  }
  if (/locations=1/.test(url)) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(
      { locations: [{ id: 'LOC-1502', code: '1502', market: 'Chicago' }, { id: 'LOC-1536', code: '1536', market: 'Joliet' }] }) });
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
};
w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {};
['suite-data.js', 'schedule-core.js', 'shift-key.js', 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js',
  'tasks-core.js', 'contacts-core.js', 'reqs-core.js', 'pto-tracker-core.js', 'plx-history-core.js', 'auth-core.js',
  'tests/suite-auth-stub.js', 'suite.js'].forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
  return w.document;
}
const d = boot('https://geodis.ebtools.pro/?view=meeting'), w = d.defaultView, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const tick = () => new Promise(r => setTimeout(r, 60));
const tile = label => {
  const el = $$('.meeting-tile').find(x => x.querySelector('.metric-label').textContent === label);
  return el ? el.querySelector('.metric-value').textContent : null;
};

setTimeout(async () => {
  console.log('— the page —');
  t('a nav item', $$('.suite-nav-btn').some(b => /Meeting Prep/.test(b.textContent)));
  t('asks for the newest against the one before', asked.length >= 1 && !/since=|from=/.test(asked[0]));
  t('assignments started', tile('Started') === '1');
  t('walkthroughs scheduled', tile('Scheduled') === '1');
  t('orders created', tile('Created') === '1');
  t('open slots', tile('Open WT slots') === '1');
  t('who started is listed', $$('.meeting-detail').some(x => /Assignments started/.test(x.textContent) && /Nuevo, Ana/.test(x.textContent)));
  t('an empty list is marked empty', $$('.meeting-detail.is-empty').some(x => /Assignments ended/.test(x.textContent)));
  t('the uploads are listed, newest first', $$('.meeting-history tbody tr').length === 2 &&
    /Cody/.test($$('.meeting-history tbody tr')[0].textContent));
  t('a push is named as one', /Scheduled push/.test($$('.meeting-history tbody tr')[1].textContent));
  t('an unrestricted importer may download', $$('[data-meeting-download]').length === 2);

  console.log('— choosing a window —');
  click($('[data-meeting-range="7d"]'));
  await tick();
  t('a 7-day window asks from a week back', /since=/.test(asked[asked.length - 1]));
  t('and is shown as chosen', $('[data-meeting-range="7d"]').getAttribute('aria-pressed') === 'true');
  click($('[data-meeting-range="pick"]'));
  await tick();
  t('picking an upload offers the older ones', $$('#meeting-from option').length === 2);
  const sel = $('#meeting-from');
  sel.value = 'a';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await tick();
  t('and asks from that one', /from=a/.test(asked[asked.length - 1]));

  console.log('— the header market narrows it —');
  const j = boot('https://geodis.ebtools.pro/?view=meeting&market=Joliet');
  await new Promise(r => setTimeout(r, 200));
  const jt = label => {
    const el = Array.from(j.querySelectorAll('.meeting-tile')).find(x => x.querySelector('.metric-label').textContent === label);
    return el ? el.querySelector('.metric-value').textContent : null;
  };
  t('the 1502 start drops out', jt('Started') === '0');
  t('the 1536 order stays', jt('Created') === '1');
  t('the window names the market', /Joliet/.test(j.querySelector('.meeting-window').textContent));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
}, 200);
