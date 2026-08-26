/* Site / account on the roster, sorting by it, and "Upcoming PTO" meaning
   upcoming rather than most recent. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const p2 = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const TODAY = day(0);

const records = [
  { badge: 'b1', person: 'Zoe Adams', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' },
  { badge: 'b2', person: 'Alan Brown', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' },
  { badge: 'b3', person: 'Mia Clark', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' },
  { badge: 'b4', person: 'No Site', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' }
];
const stores = {
  attendance: [
    { id: 'a1', badge: 'b1', date: day(-1), type: 'Absent', points: 1 },
    { id: 'a2', badge: 'b2', date: day(-2), type: 'Late', points: 0.5 },
    { id: 'a3', badge: 'b3', date: day(-3), type: 'Absent', points: 2 }
  ],
  timeOff: [
    { id: 't-past', badge: 'b1', type: 'PTO', start: day(-9), end: day(-8), hours: 16, status: 'Approved' },
    { id: 't-today', badge: 'b2', type: 'PTO', start: day(-1), end: TODAY, hours: 16, status: 'Approved' },
    { id: 't-soon', badge: 'b3', type: 'PTO', start: day(3), end: day(4), hours: 16, status: 'Received' },
    { id: 't-later', badge: 'b1', type: 'VTO', start: day(20), end: day(20), hours: 8, status: 'Received' }
  ],
  requisitions: [], performance: [], discrepancies: [],
  // Zoe at 1519/LEGO SAH, Alan at 1502/CCM, Mia at 1502/LEGO SAH, No Site untagged.
  shifts: [
    { id: 'e1', nameKey: 'adams zoe', name: 'Adams, Zoe', shift: '1st', building: '1519', account: 'LEGO SAH', source: 'PLX workbook' },
    { id: 'e2', nameKey: 'alan brown', name: 'Brown, Alan', shift: '2nd', building: '1502', account: 'CCM', source: 'PLX workbook' },
    { id: 'e3', nameKey: 'clark mia', name: 'Clark, Mia', shift: 'A', building: '1502', account: 'LEGO SAH', source: 'PLX workbook' }
  ]
};

const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>h</header><main id="recon-main"><div id="tbody">R</div></main></body></html>`,
  { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {}; w.prompt = () => 'Tester';
w.XLSX = { read: () => ({ SheetNames: [], Sheets: {} }), utils: { sheet_to_json: x => x } };
w.fetch = u => {
  const s = String(u);
  if (s.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (/schedule=1|coverage=1|payroll=1/.test(s)) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  const k = s.match(/\?(\w+)=1/)[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions',
    performance: 'performance', shifts: 'shifts', discrepancies: 'discrepancies' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: stores[map[k]] }) });
};
['suite-data.js', 'schedule-core.js', 'shift-key.js', 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'suite.js']
  .forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = ms => new Promise(r => setTimeout(r, ms));
const headers = () => $$('.suite-table thead th').map(th => th.textContent.replace(/[▲▼]/g, '').trim());
const colIndex = label => headers().indexOf(label);
const column = label => { const i = colIndex(label);
  return $$('.suite-table tbody tr').map(tr => (tr.querySelectorAll('td')[i] || {}).textContent || ''); };
const names = () => $$('.suite-table tbody tr').map(tr => tr.querySelectorAll('td')[0].textContent);

(async () => {
  await settle(60);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));

  console.log('— site / account on the roster —');
  click($('[data-nav="associates"]'));
  t('a Site / account column exists', colIndex('Site / account') !== -1);
  const zoe = $$('.suite-table tbody tr').find(tr => tr.textContent.indexOf('Zoe Adams') !== -1);
  t('the site number is shown', zoe.textContent.indexOf('1519') !== -1);
  t('and the account name', zoe.textContent.indexOf('LEGO SAH') !== -1);
  const none = $$('.suite-table tbody tr').find(tr => tr.textContent.indexOf('No Site') !== -1);
  t('an untagged associate shows a dash, not a blank', none.querySelectorAll('td')[colIndex('Site / account')].textContent.trim() === '—');
  t('the profile carries it', w.GEODISSuite.profile('b1').locationLabel === '1519 · LEGO SAH');

  console.log('— sorting the roster —');
  t('defaults to name ascending', names()[0].indexOf('Alan Brown') !== -1);
  click($('[data-sort="associates:location"]'));
  let sites = column('Site / account').map(x => x.trim());
  t('sorts by site', sites[0].indexOf('1502') === 0 && sites[1].indexOf('1502') === 0);
  t('1519 comes after 1502', sites[2].indexOf('1519') === 0);
  t('the untagged one sinks to the bottom', sites[3].indexOf('—') === 0);
  t('within a site it falls back to name',
    names()[0].indexOf('Alan Brown') !== -1 && names()[1].indexOf('Mia Clark') !== -1);
  t('the header shows it is sorted', $('[data-sort="associates:location"]').className.indexOf('sorted') !== -1);

  click($('[data-sort="associates:location"]'));
  sites = column('Site / account').map(x => x.trim());
  t('clicking again reverses', sites[0].indexOf('1519') === 0);
  t('and the blank STILL sinks, not floats', sites[3].indexOf('—') === 0);

  click($('[data-sort="associates:points"]'));
  const pts = column('Attendance pts').map(x => Number(x.trim()));
  t('points sort numerically', pts[0] <= pts[1] && pts[1] <= pts[2]);
  t('switching column starts ascending', w.GEODISSuite.state.sort.associates.dir === 1);

  console.log('— sorting attendance by site —');
  click($('[data-nav="attendance"]'));
  t('attendance has a Site / account column', colIndex('Site / account') !== -1);
  t('defaults to newest first', column('Date')[0].trim() === day(-1));
  click($('[data-sort="attendance:location"]'));
  const asites = column('Site / account').map(x => x.trim());
  t('sorts by site', asites[0].indexOf('1502') === 0);
  t('and the site is shown on the row', asites.join(' ').indexOf('CCM') !== -1);
  click($('[data-sort="attendance:date"]'));
  t('date is sortable too', column('Date')[0].trim() === day(-3));

  console.log('— Upcoming PTO —');
  click($('[data-nav="overview"]'));
  const panel = $$('.suite-panel').find(x => x.textContent.indexOf('Upcoming PTO') !== -1);
  t('the panel is renamed', !!panel);
  t('no longer says "Time off activity"', d.body.textContent.indexOf('Time off activity') === -1);
  t('a request that already ended is excluded', panel.textContent.indexOf('Zoe Adams') === -1 ||
    panel.textContent.indexOf('VTO') !== -1);
  t('one ending today still counts as upcoming', panel.textContent.indexOf('Alan Brown') !== -1);
  t('a future one is included', panel.textContent.indexOf('Mia Clark') !== -1);
  const order = panel.textContent;
  t('soonest first', order.indexOf('Alan Brown') < order.indexOf('Mia Clark'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
