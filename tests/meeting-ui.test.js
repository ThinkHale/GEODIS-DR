/* The Meeting Prep page: what it shows for a comparison, the window picker, the
   header's market filter, and who is offered the workbook download. */
const { JSDOM } = require('jsdom'); const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
const H = require('../plx-history-core.js');
let pass = 0, fail = 0; const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

// Two snapshots, built by hand: one start at 1502, one new order at 1536, and a
// candidate at 1536 who turned green.
const before = { version: 2, takenAt: '2026-09-22T08:00:00Z', highlights: true,
  customers: { 1502: ['CCM', 'LEGO SAH'], 1536: ['REDBULL'] },
  sites: { 1502: { location: '1502', sheet: '1502 - HC', expected: 3, onsite: 2, short: 1 } },
  roster: { 'E-1': { eid: 'E-1', name: 'Grachen, Luz', location: '1502', customer: 'CCM' },
    'E-9': { eid: 'E-9', name: 'Gone, Gary', location: '1502', customer: 'CCM' } },
  candidates: { 'mia ortiz': { key: 'mia ortiz', name: 'Ortiz, Mia', stage: 'pipeline', location: '1536',
    customer: 'REDBULL', position: 'Operator', wtDate: '', color: '', highlight: '' } },
  openSlots: { 1502: 2 }, slots: [], orders: {}, attendance: {}, starts: [] };
const after = Object.assign({}, before, { takenAt: '2026-10-01T08:00:00Z',
  roster: { 'E-1': before.roster['E-1'],
    'E-2': { eid: 'E-2', name: 'Nuevo, Ana', location: '1502', site: '1502 - HC', shift: '1st', customer: 'LEGO SAH' },
    'E-3': { eid: 'E-3', name: 'Otro, Ben', location: '1502', site: '1502 - HC', shift: '1st', customer: 'LEGO SAH' } },
  candidates: { 'mia ortiz': Object.assign({}, before.candidates['mia ortiz'], { wtDate: '10/2 9am', color: 'green', highlight: 'accepted' }) },
  openSlots: { 1502: 1 }, slots: [{ location: '1502', customer: 'LEGO SAH', position: 'Operator', color: 'green' }],
  orders: { 111000: { req: '111000', location: '1536', account: 'Redbull', customer: 'REDBULL',
    position: 'Material Handler', openings: 4 } },
  starts: [{ week: '2026-09-21', location: '1502', count: 2 }, { week: '2026-09-28', location: '1536', count: 3 }] });
const comparison = { from: { id: 'a', takenAt: before.takenAt }, to: { id: 'b', takenAt: after.takenAt },
  partial: false, changes: H.diff(before, after) };
const uploads = [
  { id: 'a', takenAt: before.takenAt, fileName: 'PLX.xlsx', via: 'push', changes: null },
  { id: 'b', takenAt: after.takenAt, fileName: 'PLX.xlsx', uploadedBy: 'Cody', via: 'upload', changes: comparison.changes.counts }
];
const trend = H.weekly([H.seriesPoint(before, null), H.seriesPoint(after, comparison.changes)], { now: '2026-10-01' });
const profile = H.profile(after);
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
      { ok: true, retentionDays: 7, uploads, comparison, profile, trend }) });
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
  const nav = $$('.suite-nav-btn').find(b => /Meeting Prep/.test(b.textContent));
  t('a nav item', !!nav);
  t('under Workforce admin, after Beeline Requests', !!nav && /Beeline Requests/.test((nav.previousElementSibling || {}).textContent || ''));

  console.log('— where things stand —');
  t('on roster against expected', tile('On roster') === '3' &&
    /3 expected/.test($$('.meeting-tile').find(x => /On roster/.test(x.textContent)).textContent));
  t('candidates identified, with the green ones', tile('Candidates identified') === '1' &&
    /1 accepted for WT/.test($$('.meeting-tile').find(x => /Candidates identified/.test(x.textContent)).textContent));
  const section = title => $$('.meeting-section').find(x => x.querySelector('h2').textContent === title);
  const sites = section('Headcount by site');
  t('headcount by site', !!sites);
  const row1502 = sites && Array.from(sites.querySelectorAll('tbody tr')).find(r => /^1502/.test(r.cells[0].textContent));
  t('the people behind the net: 2 added, 1 removed, net +1', !!row1502 &&
    row1502.cells[5].textContent === '+2' && row1502.cells[6].textContent === '−1' && row1502.cells[7].textContent === '+1');
  t('customers per site', !!row1502 && /CCM/.test(row1502.cells[1].textContent) && /LEGO SAH/.test(row1502.cells[1].textContent));
  const wow = section('Week over week');
  t('week over week, newest first', !!wow && wow.querySelectorAll('tbody tr').length === 2 &&
    /Sep 28/.test(wow.querySelector('tbody tr').cells[0].textContent));
  t('with the weekly change', !!wow && wow.querySelector('tbody tr').cells[2].textContent === '+1');
  t('and starts that week', !!wow && wow.querySelector('tbody tr').cells[5].textContent === '3');
  const pos = section('Open positions');
  t('openings by position', !!pos && /Material Handler/.test(pos.textContent) && /Operator/.test(pos.textContent));
  const cust = section('Orders by customer');
  const redbull = cust && Array.from(cust.querySelectorAll('tbody tr')).find(r => /REDBULL/.test(r.textContent));
  t('orders by customer', !!redbull && redbull.cells[4].textContent === '4' && redbull.cells[6].textContent === '4');
  t('a workbook order Beeline does not have says so', !!redbull && /Not in Beeline/.test(redbull.textContent));
  t('starts per week', !!section('Starts per week'));
  t('asks for the newest against the one before', asked.length >= 1 && !/since=|from=/.test(asked[0]));
  t('assignments started', tile('Started') === '2');
  t('walkthroughs scheduled', tile('Scheduled') === '1');
  t('orders created', tile('Created') === '1');
  t('open slots', tile('Open WT slots') === '1');
  t('accepted for walkthrough (newly green)', $$('.meeting-detail').some(x => /newly green/.test(x.textContent) && /Ortiz, Mia/.test(x.textContent)));
  t('who started is listed', $$('.meeting-detail').some(x => /Assignments started/.test(x.textContent) && /Nuevo, Ana/.test(x.textContent)));
  t('an empty list is marked empty', $$('.meeting-detail.is-empty').some(x => /Orders filled/.test(x.textContent)));
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
  t('the 1502 starts drop out', jt('Started') === '0');
  t('and its headcount', jt('On roster') === '0');
  t('the 1536 order stays', jt('Created') === '1');
  t('the window names the market', /Joliet/.test(j.querySelector('.meeting-window').textContent));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
}, 200);
