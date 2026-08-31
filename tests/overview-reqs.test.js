/* The dashboard's Beeline requests panel.

   The regression this guards: the requisitions collection holds TWO namespaces on
   one record -- openings/filled written by the PLX workbook sync, and
   beelineOpenings/hired written by the Beeline import. The overview read the
   first pair directly, so it saw only the handful of requests the workbook also
   lists and reported 103 seats short when the real figure was 370. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const records = [
  { badge: 'C1', person: 'Ann Chi', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' },
  { badge: 'S1', person: 'Sam Lou', action: 'matched', actionLabel: 'M', reason: '', market: 'St. Louis' }
];
/* Three requests, shaped the way each source actually writes them:
   - CHI-1  Beeline only          10 wanted, 4 hired  -> 6 short
   - STL-1  Beeline only           5 wanted, 5 hired  -> 0 short
   - WB-1   PLX workbook only      7 wanted           -> the old code saw ONLY this */
const requisitions = [
  { id: 'REQ-100', beelineReq: '100-1', beelineStatus: 'Open', beelineOpenings: 10, hired: 4,
    submitted: 6, jobPosition: 'Material Handler', market: 'Chicago', startDate: '2026-08-01' },
  { id: 'REQ-200', beelineReq: '200-1', beelineStatus: 'Open', beelineOpenings: 5, hired: 5,
    submitted: 5, jobPosition: 'Operator 1', market: 'St. Louis', startDate: '2026-08-02' },
  { id: 'REQ-300', source: 'PLX workbook', title: 'Loader', openings: 7, filled: 0, status: 'Open',
    market: 'Chicago', building: '1536', shift: '1st' }
];
const reqCandidates = [
  { id: 'REQ-100|a', reqId: '100-1', name: 'Cand One', beelineId: 'C1', status: 'Offer Confirmed' },
  { id: 'REQ-100|b', reqId: '100-1', name: 'Cand Two', beelineId: 'C2', status: 'Offer Pending' }
];
const stores = { attendance: [], timeOff: [], requisitions, reqCandidates, performance: [],
  shifts: [], discrepancies: [] };

const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>h</header><main id="recon-main"><div id="tbody">R</div></main></body></html>`,
  { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {};
w.XLSX = { read: () => ({ SheetNames: [], Sheets: {} }), utils: { sheet_to_json: x => x } };
w.fetch = u => {
  const s = String(u);
  if (/plx=1|schedule=1|coverage=1|payroll=1/.test(s)) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  const k = (s.match(/\?(\w+)=1/) || [])[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions',
    reqCandidates: 'reqCandidates', performance: 'performance', shifts: 'shifts', discrepancies: 'discrepancies' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: stores[map[k]] || [] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'reconcile-core.js', 'suite-data.js', 'schedule-core.js',
 'shift-key.js', 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js',
 'contacts-core.js', 'reqs-core.js', 'suite.js'].forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const panel = () => $$('.suite-panel').find(p => /Beeline requests/i.test(p.textContent));
const unfilled = () => {
  const row = $$('.alert-row').find(r => /Unfilled Beeline request/.test(r.textContent));
  return row ? Number(row.querySelector('.alert-num').textContent) : null;
};

setTimeout(() => {
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));

  console.log('— the shortfall counts every source, not just the workbook —');
  // 6 short on CHI-1 + 0 on STL-1 + 7 on the workbook-only row = 13.
  t('unfilled positions add up across both namespaces', unfilled() === 13);
  t('reading only the workbook fields would have said 7', unfilled() !== 7);

  console.log('— the panel summarises the board —');
  const note = panel().querySelector('.overview-req-note');
  t('a summary line is shown', !!note);
  t('it counts the Beeline requests', note.textContent.indexOf('2 open request') !== -1);
  t('and their seats', note.textContent.indexOf('15') !== -1);             // 10 + 5
  t('and their shortfall', note.textContent.indexOf('6') !== -1);
  // The workbook-only request is counted apart rather than averaged in.
  t('the request Beeline does not have is disclosed separately',
    note.textContent.indexOf('1 not in Beeline') !== -1 && note.textContent.indexOf('7 short') !== -1);

  console.log('— the rows are Beeline requests, not the old columns —');
  const head = [...panel().querySelectorAll('thead th')].map(x => x.textContent);
  t('the job position is shown', panel().textContent.indexOf('Material Handler') !== -1);
  t('with its request id', panel().textContent.indexOf('100-1') !== -1);
  t('and the market', head.indexOf('Market') !== -1);
  t('and how many were submitted', head.indexOf('Submitted') !== -1);
  t('the old Department/Shift columns are gone', head.indexOf('Department') === -1 && head.indexOf('Shift') === -1);
  t('the most short-handed request is first',
    panel().querySelector('tbody tr').textContent.indexOf('100-1') !== -1);
  t('a fully-filled request shows no shortfall', (() => {
    const row = [...panel().querySelectorAll('tbody tr')].find(r => /200-1/.test(r.textContent));
    return row && row.textContent.indexOf('short') === -1;
  })());

  console.log('— the market picker scopes it —');
  w.GEODISSuite.state.market = 'St. Louis';
  w.GEODISSuite.go('overview');
  t('only St. Louis counts toward the shortfall', unfilled() === 0);
  t('and only its request is listed', panel().textContent.indexOf('200-1') !== -1 &&
    panel().textContent.indexOf('100-1') === -1);

  w.GEODISSuite.state.market = 'Chicago';
  w.GEODISSuite.go('overview');
  t('Chicago sees its Beeline request and the workbook one', unfilled() === 13);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}, 80);
