/* The header market picker scopes the WHOLE tool. This walks every view with a
   two-market roster and asserts each one narrows, including the overview figures
   that were reading every market. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

// 2 Chicago associates, 1 St. Louis. Every module has records in both markets.
const records = [
  { badge: 'C1', person: 'Ann Chi', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago' },
  { badge: 'C2', person: 'Bob Chi', action: 'addBeeline', actionLabel: 'Add to Beeline', reason: 'x', market: 'Chicago' },
  { badge: 'S1', person: 'Sam Lou', action: 'addBeeline', actionLabel: 'Add to Beeline', reason: 'x', market: 'St. Louis' }
];
const today = (() => { const d = new Date(), p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })();
const stores = {
  attendance: [
    { id: 'a1', badge: 'C1', date: today, type: 'Absent', points: 6 },
    { id: 'a2', badge: 'S1', date: today, type: 'Absent', points: 6 },
    { id: 'a3', badge: 'S1', date: today, type: 'Present', points: 0 }
  ],
  timeOff: [
    { id: 't1', badge: 'C1', type: 'PTO', start: today, end: today, hours: 8, status: 'Pending' },
    { id: 't2', badge: 'S1', type: 'VTO', start: today, end: today, hours: 4, status: 'Pending' }
  ],
  requisitions: [
    { id: 'R-CHI', title: 'Loader', market: 'Chicago', openings: 5, filled: 1, status: 'Open', department: 'W', shift: '1st' },
    { id: 'R-STL', title: 'Picker', market: 'St. Louis', openings: 4, filled: 0, status: 'Open', department: 'W', shift: '1st' },
    { id: 'R-ANY', title: 'Floater', market: '', openings: 2, filled: 0, status: 'Open', department: 'W', shift: '1st' }
  ],
  performance: []
};

const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>legacy</header><main id="recon-main"><div id="tbody">R</div></main>
</body></html>`, { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {};
w.fetch = url => {
  const u = String(url);
  if (u.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (u.indexOf('schedule=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ schedule: {} }) });
  if (u.indexOf('coverage=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ coverage: {
    checks: [{ asOf: today + 'T10:00:00', presentKeys: ['b:C1', 'b:S1'],
      exceptions: [{ key: 'b:C2', badge: 'C2', status: 'missing' }] }], documented: {}
  } }) });
  const k = u.match(/\?(\w+)=1/)[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions', performance: 'performance', shifts: 'shifts', discrepancies: 'discrepancies' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: stores[map[k]] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js', 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js', 'contacts-core.js', 'reqs-core.js', 'pto-tracker-core.js', 'suite.js'].forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const pickMarket = m => { const s = $('#market-picker'); s.value = m; s.dispatchEvent(new w.Event('change', { bubbles: true })); };
const metrics = () => $$('.metric').map(el => el.querySelector('.metric-value').textContent.trim());
const priorities = () => $$('.overview-priority').map(el => el.querySelector('strong').textContent.trim());
const bodyText = () => d.body.textContent;

setTimeout(() => {
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));

  console.log('— the picker itself —');
  t('picker rendered', !!$('#market-picker'));
  t('both markets offered', bodyText().indexOf('Chicago') !== -1 && bodyText().indexOf('St. Louis') !== -1);

  console.log('— overview, all markets —');
  let m = metrics();
  t('3 active associates', m[0] === '3');
  t('2 pending time-off', m[2] === '2');
  t('2 reconciliation exceptions', priorities()[0] === '2');

  console.log('— overview, scoped to Chicago (the reported bug) —');
  pickMarket('Chicago');
  m = metrics();
  t('active narrows to 2', m[0] === '2');
  t('pending time-off narrows to 1', m[2] === '1');
  t('exceptions narrow to 1', priorities()[0] === '1');
  t('St. Louis associate gone from the roster note', bodyText().indexOf('3 on the assignment roster') === -1);
  t('time-off activity shows only Chicago', bodyText().indexOf('Sam Lou') === -1);
  t('requisition table shows only Chicago + unassigned',
    bodyText().indexOf('R-CHI') !== -1 && bodyText().indexOf('R-STL') === -1);
  t('an unassigned requisition stays visible', bodyText().indexOf('R-ANY') !== -1);
  t('at-risk count is market-scoped', bodyText().indexOf('1') !== -1);

  console.log('— overview, scoped to St. Louis —');
  pickMarket('St. Louis');
  m = metrics();
  t('active narrows to 1', m[0] === '1');
  t('pending time-off narrows to 1', m[2] === '1');
  t('attendance rate is computed from St. Louis only', m[1] === '100%');
  pickMarket('Chicago');
  t('Chicago attendance rate differs', metrics()[1] === '50%');

  console.log('— associates —');
  click($('[data-nav="associates"]'));
  t('only Chicago rows', $$('.suite-table tbody tr').length === 2);
  t('St. Louis associate absent', bodyText().indexOf('Sam Lou') === -1);

  console.log('— attendance —');
  click($('[data-nav="attendance"]'));
  t('only Chicago occurrences', $$('.suite-table tbody tr').length === 1);
  t('St. Louis occurrence hidden', bodyText().indexOf('Sam Lou') === -1);

  console.log('— time off —');
  click($('[data-nav="timeoff"]'));
  t('only Chicago requests', $$('.suite-table tbody tr').length === 1);

  console.log('— requisitions —');
  click($('[data-nav="requisitions"]'));
  const ids = bodyText();
  t('Chicago requisition shown', ids.indexOf('R-CHI') !== -1);
  t('St. Louis requisition hidden', ids.indexOf('R-STL') === -1);
  t('unassigned requisition still shown', ids.indexOf('R-ANY') !== -1);

  console.log('— the market survives navigation and reload —');
  click($('[data-nav="overview"]'));
  t('still on Chicago after navigating', $('#market-picker').value === 'Chicago');
  t('persisted for next session', w.localStorage.getItem('badgeCrosscheck.market') === 'Chicago');

  console.log('— synced with the reconciliation view —');
  let seen = null;
  d.addEventListener('geodis:market', e => { if (e.detail.source === 'suite') seen = e.detail.market; });
  pickMarket('St. Louis');
  t('choosing in the header notifies reconciliation', seen === 'St. Louis');
  d.dispatchEvent(new w.CustomEvent('geodis:market', { detail: { market: 'Chicago', source: 'recon' } }));
  t('choosing in reconciliation updates the suite', w.GEODISSuite.state.market === 'Chicago');
  t('and the header picker follows', $('#market-picker').value === 'Chicago');
  t('no echo loop back to reconciliation', seen === 'St. Louis');

  console.log('— a stale market cannot filter everything to nothing —');
  w.GEODISSuite.state.market = 'Nowhere';
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));
  t('unknown market falls back to all', w.GEODISSuite.state.market === 'all');
  t('and the roster is visible again', metrics()[0] === '3');

  console.log('— back to all markets —');
  pickMarket('all');
  t('everything returns', metrics()[0] === '3');
  click($('[data-nav="associates"]'));
  t('all three associates listed', $$('.suite-table tbody tr').length === 3);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}, 60);
