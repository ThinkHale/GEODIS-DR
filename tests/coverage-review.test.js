/* Reviewing a stored on-premise check, and the profile showing ONE attendance
   state however many times the report was pulled. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const records = [
  { badge: 'b1', person: 'Ava Reed', action: 'matched', actionLabel: 'Matched', reason: '', market: 'STL', crmStart: '1/2/2026' },
  { badge: 'b2', person: 'Cleo Nash', action: 'matched', actionLabel: 'Matched', reason: '', market: 'STL', crmStart: '1/3/2026' }
];
const K_AVA = 'b:b1', K_CLEO = 'b:b2';
/* The profile shows TODAY's checks, so the fixture is keyed to today rather than
   a fixed date -- otherwise this passes only on the day it was written. */
const p2 = n => String(n).padStart(2, '0');
const TODAY = (() => { const d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); })();
const YESTERDAY = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); })();
const ex = (key, name, badge, status, loc, mgr) => ({
  key, name, badge, wfmId: '80-X', status: status || 'missing',
  shift: '7:00 AM - 3:30 PM', location: 'GEODIS/US/CL/CL' + (loc || '1523') + '/' + (loc || '1523'),
  manager: mgr || 'Boss, B'
});
const EXTRA = ex('n:eli extra', 'Extra, Eli', '', 'unscheduled', '1541', 'Other, O');
// Three pulls: Ava absent then absent then present; Cleo absent throughout.
const days = {
  [TODAY]: {
    date: TODAY,
    checks: [
      { id: 'C1', asOf: TODAY + 'T10:00:00', fileName: 'onprem-10.csv', summary: { onShift: 2, byStatus: { working: 0, missing: 2, unscheduled: 0 }, coverage: 0 }, presentKeys: [], exceptions: [ex(K_AVA, 'Reed, Ava', 'b1'), ex(K_CLEO, 'Nash, Cleo', 'b2'), EXTRA] },
      { id: 'C2', asOf: TODAY + 'T10:15:00', fileName: 'onprem-1015.csv', summary: { onShift: 2, byStatus: { working: 0, missing: 2, unscheduled: 0 }, coverage: 0 }, presentKeys: [], exceptions: [ex(K_AVA, 'Reed, Ava', 'b1'), ex(K_CLEO, 'Nash, Cleo', 'b2')] },
      { id: 'C3', asOf: TODAY + 'T10:30:00', fileName: 'onprem-1030.csv', summary: { onShift: 2, byStatus: { working: 1, missing: 1, unscheduled: 0 }, coverage: 50 }, presentKeys: [K_AVA], exceptions: [ex(K_CLEO, 'Nash, Cleo', 'b2')] }
    ],
    documented: {}
  },
  [YESTERDAY]: { date: YESTERDAY, checks: [{ id: 'B1', asOf: YESTERDAY + 'T09:00:00', fileName: 'y.csv', summary: { onShift: 1, byStatus: { working: 1, missing: 0, unscheduled: 0 }, coverage: 100 }, presentKeys: [K_AVA], exceptions: [ex(K_CLEO, 'Nash, Cleo', 'b2')] }], documented: {} }
};

const posts = [];
const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>h</header><main id="recon-main"><div id="tbody">R</div></main></body></html>`,
  { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
w.alert = m => posts.push({ alert: m }); w.confirm = () => true; w.scrollTo = () => {};
w.XLSX = { read: () => ({ SheetNames: [], Sheets: {} }), utils: { sheet_to_json: x => x } };
w.fetch = (url, opt) => {
  const u = String(url);
  if (opt && opt.method === 'POST') {
    const body = JSON.parse(opt.body);
    posts.push({ url: u, body });
    const dm = u.match(/date=([\d-]+)/);
    if (dm && body.document) {
      const d = days[dm[1]] || (days[dm[1]] = { date: dm[1], checks: [], documented: {} });
      d.documented[body.document.key] = body.document;
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  }
  const dm = u.match(/coverage=1&date=([\d-]+)/);
  if (dm) return Promise.resolve({ ok: true, json: () => Promise.resolve({ coverage: days[dm[1]] || {} }) });
  if (u.indexOf('coverage=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ dates: Object.keys(days).sort() }) });
  if (u.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (u.indexOf('schedule=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ schedule: {} }) });
  const k = u.match(/\?(\w+)=1/)[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions', performance: 'performance', shifts: 'shifts', discrepancies: 'discrepancies' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: [] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js', 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js', 'contacts-core.js', 'reqs-core.js', 'suite.js'].forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const pick = (id, v) => { const s = $(id); s.value = v; s.dispatchEvent(new w.Event('change', { bubbles: true })); };
const settle = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await settle(60);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));

  console.log('— the profile shows ONE state, not one per upload —');
  click($('[data-nav="associates"]'));
  click($('[data-profile="b1"]'));
  t('exactly one attendance state rendered', $$('.att-state').length === 1);
  t('Ava reads on premise, because she was seen at 10:30', $('.att-state').textContent.indexOf('On premise') !== -1);
  t('"Not on premise" is not repeated', (d.body.textContent.match(/Not on premise/g) || []).length === 0);
  t('the three pulls are kept as detail', $$('.att-timeline span').length === 3);
  t('the timeline shows two absent and one present',
    $$('.att-timeline span.off').length === 2 && $$('.att-timeline span.on').length === 1);

  click($('[data-nav="associates"]'));
  click($('[data-profile="b2"]'));
  t('Cleo, absent at every pull, reads absent', $('.att-state').textContent.indexOf('Not clocked in') !== -1);
  t('still only one state', $$('.att-state').length === 1);

  console.log('— the review dropdown —');
  click($('[data-nav="coverage"]'));
  t('a review picker is offered even with nothing uploaded', !!$('#review-date'));
  t('it lists the stored days', $$('#review-date option').length === 3);
  t('newest first', $$('#review-date option')[1].value === TODAY);
  t('and offers a way back to the live view', $$('#review-date option')[0].value === '');

  pick('#review-date', TODAY);
  await settle(60);
  t('a pull picker appears', !!$('#review-check'));
  t('all three pulls listed', $$('#review-check option').length === 3);
  t('labelled by time', $$('#review-check option')[0].textContent.indexOf('10:00') === 0);
  t('and by that pull’s coverage', $$('#review-check option')[2].textContent.indexOf('50%') !== -1);
  t('defaults to the most recent pull', $('#review-check').value === 'C3');
  t('a banner says this is stored, not live', d.body.textContent.indexOf('Stored check') !== -1);
  t('the file name is shown', d.body.textContent.indexOf('onprem-1030.csv') !== -1);
  t('that pull’s exception is listed', d.body.textContent.indexOf('Nash, Cleo') !== -1);
  t('the person present at that pull is not an exception', d.body.textContent.indexOf('Reed, Ava') === -1);
  t('it is honest that only exceptions are stored', d.body.textContent.indexOf('does not keep a row per person') !== -1);

  console.log('— switching pulls —');
  pick('#review-check', 'C1');
  await settle(40);
  t('the 10:00 pull shows both people absent',
    d.body.textContent.indexOf('Nash, Cleo') !== -1 && d.body.textContent.indexOf('Reed, Ava') !== -1);
  t('and its own coverage figure', d.body.textContent.indexOf('0%') !== -1);

  console.log('— filters work inside a stored check —');
  t('a filter row is rendered', !!$('#cov-status') && !!$('#cov-loc'));
  t('search box is offered', !!$('#suite-search'));
  const bodyRows = () => $$('.suite-table tbody tr').length;
  t('all three exceptions listed', bodyRows() === 3);
  t('status options come from this check', $$('#cov-status option').length === 3);
  t('and are counted', $$('#cov-status option')[0].textContent.indexOf('(3)') !== -1);

  pick('#cov-status', 'unscheduled');
  t('status filter narrows', bodyRows() === 1);
  t('to the right person', d.querySelector('.suite-table tbody tr').textContent.indexOf('Extra, Eli') !== -1);
  pick('#cov-status', 'missing');
  t('the other status narrows too', bodyRows() === 2);
  pick('#cov-status', 'all');
  t('back to all', bodyRows() === 3);

  t('location options come from this check', $$('#cov-loc option').length === 3);
  pick('#cov-loc', '1541');
  t('location filter narrows', bodyRows() === 1);
  pick('#cov-loc', 'all');
  t('back to all locations', bodyRows() === 3);

  const box = $('#suite-search');
  box.value = 'cleo'; box.dispatchEvent(new w.Event('input', { bubbles: true }));
  t('search narrows', bodyRows() === 1);
  t('search keeps focus', d.activeElement.id === 'suite-search');
  const box2 = $('#suite-search');
  box2.value = ''; box2.dispatchEvent(new w.Event('input', { bubbles: true }));
  t('clearing search restores', bodyRows() === 3);

  const mp = $('#market-picker');
  mp.value = 'STL'; mp.dispatchEvent(new w.Event('change', { bubbles: true }));
  t('still reviewing after a market change', !!$('#review-check'));
  t('market filter applies to a stored check', bodyRows() === 3);
  t('the unrostered row is not hidden by a market', d.body.textContent.indexOf('Extra, Eli') !== -1);
  mp.value = 'all'; mp.dispatchEvent(new w.Event('change', { bubbles: true }));

  const box3 = $('#suite-search');
  box3.value = 'zzzznobody'; box3.dispatchEvent(new w.Event('input', { bubbles: true }));
  t('a filtered-to-nothing table says so', d.body.textContent.indexOf('Nothing matches those filters') !== -1);
  t('and does not claim the check had no exceptions',
    d.body.textContent.indexOf('No exceptions in this check') === -1);
  const box4 = $('#suite-search');
  box4.value = ''; box4.dispatchEvent(new w.Event('input', { bubbles: true }));
  t('restored', bodyRows() === 3);

  console.log('— documenting while reviewing writes to that day —');
  // Cleo is absent at all three pulls, so she is the one the override must fix.
  const cleoRow = $$('.suite-table tbody tr').find(tr => tr.textContent.indexOf('Nash, Cleo') !== -1);
  t('exceptions in a stored check can be documented', !!cleoRow && !!cleoRow.querySelector('.cov-disp'));
  const disp = cleoRow.querySelector('.cov-disp');
  disp.value = 'Present';
  disp.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  const docPost = posts.filter(p => p.body && p.body.document).pop();
  t('documentation POSTed', !!docPost);
  t('filed under the day on screen', docPost.url.indexOf('date=' + TODAY) !== -1);
  t('"Present" is an available disposition', docPost.body.document.disposition === 'Present');

  console.log('— documenting a PAST day files against that day, not today —');
  pick('#review-date', YESTERDAY);
  await settle(60);
  const pastRow = $$('.suite-table tbody tr').find(tr => tr.textContent.indexOf('Nash, Cleo') !== -1);
  t('yesterday’s exception is shown', !!pastRow);
  const pastDisp = pastRow.querySelector('.cov-disp');
  pastDisp.value = 'Called in';
  pastDisp.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  const pastPost = posts.filter(p => p.body && p.body.document).pop();
  t('filed against yesterday', pastPost.url.indexOf('date=' + YESTERDAY) !== -1);
  t('and not against today', pastPost.url.indexOf('date=' + TODAY) === -1);
  pick('#review-date', TODAY);
  await settle(60);

  console.log('— Present clears the absence on the profile —');
  click($('[data-nav="associates"]'));
  click($('[data-profile="b2"]'));
  t('Cleo now reads present', $('.att-state').textContent.indexOf('Present') !== -1);
  t('and is marked as documented, not sighted', $('.att-state').textContent.indexOf('documented') !== -1);
  t('still exactly one state', $$('.att-state').length === 1);

  console.log('— leaving review —');
  click($('[data-nav="coverage"]'));
  t('still reviewing after navigating away and back', !!$('#review-check'));
  click($('[data-review-exit]'));
  await settle(40);
  t('back to the live view', !$('#review-check'));
  t('and the picker resets', $('#review-date').value === '');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
