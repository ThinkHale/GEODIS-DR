/* The Payroll tab: discrepancies from the form, and Beeline hours changes. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const records = [
  { badge: '215001', person: 'Luz Grachen', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' },
  { badge: '215002', person: 'Abel Munoz', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' }
];
let stores = {
  attendance: [], timeOff: [], requisitions: [], performance: [], shifts: [],
  discrepancies: [
    { id: 'PDF-900', badge: '215001', name: 'Luz Grachen', location: 'LEGO', date: '2026-08-25',
      weekEnding: '2026-08-30', details: 'Missing 4 hours Tuesday', status: 'Received',
      source: 'Payroll discrepancy form', submittedAt: '2026-08-25T10:00:00Z' },
    { id: 'PDF-901', badge: '', name: 'Luiz Grachan', location: 'Redbull', date: '2026-09-01',
      weekEnding: '2026-09-06', details: 'Overtime not paid', status: 'Received',
      source: 'Payroll discrepancy form' }
  ]
};
const periods = {
  '2026-08-30': {
    weekEnding: '2026-08-30', closesAt: '2026-09-01T17:00:00Z',
    snapshots: [
      { takenAt: '2026-08-31T09:00:00Z', summary: { totalHours: 78, people: 2, net: 0 } },
      { takenAt: '2026-09-02T15:00:00Z', summary: { totalHours: 52, people: 2, net: -26 },
        rows: [{ badge: '215001', name: 'Luz Grachen', hours: 44 }] }
    ],
    changes: [
      { kind: 'changed', badge: '215001', name: 'Luz Grachen', from: 40, to: 44, delta: 4, at: '2026-09-02T15:00:00Z', afterClose: true },
      { kind: 'removed', badge: '215002', name: 'Abel Munoz', from: 38, to: 0, delta: -38, at: '2026-09-02T15:00:00Z', afterClose: true },
      { kind: 'added', badge: '3', name: 'New Person', from: 0, to: 8, delta: 8, at: '2026-08-31T09:00:00Z', afterClose: false }
    ]
  }
};

const posts = [];
const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>h</header><main id="recon-main"><div id="tbody">R</div></main></body></html>`,
  { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
w.alert = m => posts.push({ alert: m }); w.confirm = () => true; w.scrollTo = () => {};
w.prompt = () => 'Cody Hale';
w.XLSX = { read: () => ({ SheetNames: [], Sheets: {} }), utils: { sheet_to_json: x => x } };
w.fetch = (url, opt) => {
  const u = String(url);
  if (opt && opt.method === 'POST') {
    const body = JSON.parse(opt.body);
    posts.push({ url: u, body });
    if (u.indexOf('discrepancies=1') !== -1 && body.id) {
      const i = stores.discrepancies.findIndex(x => x.id === body.id);
      if (i !== -1) stores.discrepancies[i] = Object.assign({}, stores.discrepancies[i], body);
    }
    if (u.indexOf('payroll=1') !== -1 && body.closesAt !== undefined) {
      const wk = u.match(/week=([\d-]+)/)[1];
      periods[wk].closesAt = body.closesAt;
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  }
  const wk = u.match(/payroll=1&week=([\d-]+)/);
  if (wk) return Promise.resolve({ ok: true, json: () => Promise.resolve({ period: periods[wk[1]] || {} }) });
  if (u.indexOf('payroll=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ periods: Object.keys(periods) }) });
  if (u.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (/schedule=1|coverage=1/.test(u)) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  const k = u.match(/\?(\w+)=1/)[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions',
    performance: 'performance', shifts: 'shifts', discrepancies: 'discrepancies' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: stores[map[k]] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js', 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js', 'suite.js']
  .forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = ms => new Promise(r => setTimeout(r, ms));
const rowFor = n => $$('.suite-table tbody tr').find(tr => tr.textContent.indexOf(n) !== -1);

(async () => {
  await settle(60);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));

  console.log('— the tab exists —');
  t('Payroll is in the sidebar', !!$('[data-nav="payroll"]'));
  t('after Time Off', $$('.suite-nav-btn').map(b => b.dataset.nav).indexOf('payroll') ===
    $$('.suite-nav-btn').map(b => b.dataset.nav).indexOf('timeoff') + 1);
  click($('[data-nav="payroll"]'));
  t('the page renders', d.body.textContent.indexOf('Hours changes and discrepancy tracking') !== -1);
  t('two sections offered', $$('[data-payroll-tab]').length === 2);
  t('discrepancies open first', $('[data-payroll-tab="discrepancies"]').className.indexOf('primary') !== -1);

  console.log('— discrepancies —');
  t('both listed', $$('.suite-table tbody tr').length === 2);
  t('details shown', d.body.textContent.indexOf('Missing 4 hours Tuesday') !== -1);
  t('location shown', d.body.textContent.indexOf('LEGO') !== -1);
  t('week ending shown', d.body.textContent.indexOf('2026-08-30') !== -1);
  t('open count', $$('.metric-value')[0].textContent.trim() === '2');
  t('unmatched counted', $$('.metric-value')[2].textContent.trim() === '1');
  t('and bannered', d.body.textContent.indexOf('could not be matched to an associate') !== -1);

  console.log('— its own pipeline, not time off’s —');
  const sel = rowFor('Luz Grachen').querySelector('.status-select');
  t('six statuses', sel.querySelectorAll('option').length === 6);
  t('Researching is offered',
    Array.from(sel.querySelectorAll('option')).some(o => o.textContent === 'Researching'));
  t('Corrected is offered',
    Array.from(sel.querySelectorAll('option')).some(o => o.textContent === 'Corrected'));
  t('time off’s client-approval step is NOT',
    !Array.from(sel.querySelectorAll('option')).some(o => o.textContent.indexOf('client approval') !== -1));

  sel.value = 'Researching';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  let post = posts.filter(p => p.url && p.url.indexOf('discrepancies=1') !== -1).pop();
  t('the change is saved to the discrepancies collection', !!post);
  t('with the new status', post.body.status === 'Researching');
  t('attributed', post.body.statusUpdatedBy === 'Cody Hale');
  t('and logged', Array.isArray(post.body.statusHistory) && post.body.statusHistory.length === 2);

  console.log('— connecting an unmatched discrepancy —');
  const orphan = rowFor('Luiz Grachan');
  t('flagged', orphan.textContent.indexOf('Not matched to a profile') !== -1);
  click(orphan.querySelector('[data-connect]'));
  t('the roster picker opens', !!$('#connect-search'));
  const box = $('#connect-search');
  box.value = 'grachen'; box.dispatchEvent(new w.Event('input', { bubbles: true }));
  t('finds the associate', $$('.connect-hit').length === 1);
  click($('.connect-hit'));
  await settle(60);
  post = posts.filter(p => p.url && p.url.indexOf('discrepancies=1') !== -1).pop();
  t('linked in the discrepancies collection', post.body.badge === '215001');
  t('who linked it', post.body.connectedBy === 'Cody Hale');
  t('the banner clears', d.body.textContent.indexOf('could not be matched to an associate') === -1);

  console.log('— Beeline hours —');
  click($('[data-payroll-tab="hours"]'));
  await settle(80);
  t('a period picker appears', !!$('#payroll-week'));
  t('the stored week is listed', $('#payroll-week').value === '2026-08-30');
  t('a close-date control is offered', !!$('#payroll-close'));
  t('changes after close are counted', $$('.metric-value')[0].textContent.trim() === '2');
  t('and bannered', d.body.textContent.indexOf('landed after this period closed') !== -1);
  t('hours on file shown', d.body.textContent.indexOf('52') !== -1);
  t('net movement shown', d.body.textContent.indexOf('-26') !== -1);

  const rows = $$('.suite-table tbody tr');
  t('all three changes listed', rows.length === 3);
  t('after-close rows are marked', $$('.cov-flag.bad').length === 2);
  t('a change shows before and after', rowFor('Luz Grachen').textContent.indexOf('44') !== -1);
  t('a removal reads negative', rowFor('Abel Munoz').textContent.indexOf('-38') !== -1);
  t('the pre-close change is not flagged', !rowFor('New Person').querySelector('.cov-flag.bad'));

  console.log('— setting the close date —');
  const closeBox = $('#payroll-close');
  closeBox.value = '2026-09-03T09:00';
  closeBox.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  post = posts.filter(p => p.url && p.url.indexOf('payroll=1') !== -1).pop();
  t('saved against that week', post.url.indexOf('week=2026-08-30') !== -1);
  t('as an ISO instant', !!Date.parse(post.body.closesAt));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
