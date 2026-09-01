/* A feed that stops arriving looks exactly like a feed with nothing new. The
   difference has to be visible in the tool, not only in Power Automate's run
   history -- that is how a failing 4pm upload went unnoticed. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const records = [{ badge: 'b1', person: 'Ava Reed', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' }];
const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString();
let plxSync = {};
let reqSync = {};

const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>h</header><main id="recon-main"><div id="tbody">R</div></main></body></html>`,
  { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {}; w.prompt = () => 'X';
w.XLSX = { read: () => ({ SheetNames: [], Sheets: {} }), utils: { sheet_to_json: x => x } };
w.fetch = u => {
  const s = String(u);
  if (s.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: plxSync }) });
  if (s.indexOf('reqSync=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: reqSync }) });
  if (/schedule=1|coverage=1|payroll=1/.test(s)) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  const k = s.match(/\?(\w+)=1/)[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions', reqCandidates: 'reqCandidates', performance: 'performance',
    shifts: 'shifts', discrepancies: 'discrepancies', associatePto: 'associatePto', locations: 'locations',
    appConfig: 'appConfig', timeclockLinks: 'timeclockLinks' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: [] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js',
 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js', 'contacts-core.js', 'reqs-core.js', 'pto-tracker-core.js', 'suite.js']
  .forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s);
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = ms => new Promise(r => setTimeout(r, ms));
const send = updatedAt => d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records, updatedAt } }));

(async () => {
  await settle(60);

  console.log('— a fresh roster says nothing alarming —');
  send(hoursAgo(3));
  t('no stale warning on the overview', d.body.textContent.indexOf('should refresh twice a day') === -1);

  console.log('— a roster that has stopped arriving —');
  send(hoursAgo(30));
  t('the overview warns', d.body.textContent.indexOf('RC / Beeline roster is') !== -1);
  t('it says how old', d.body.textContent.indexOf('30 hours ago') !== -1);
  t('and points at the likely cause', d.body.textContent.indexOf('401') !== -1);
  t('naming the flow, not the tool', d.body.textContent.indexOf('Power Automate') !== -1);

  console.log('— the boundary —');
  send(hoursAgo(19));
  t('19 hours is still within a run cycle', d.body.textContent.indexOf('should refresh twice a day') === -1);
  send(hoursAgo(21));
  t('21 hours means two runs were missed', d.body.textContent.indexOf('should refresh twice a day') !== -1);

  /* The workbook is not automated -- it lives in another Microsoft tenant, so
     somebody uploads it. Its absence must point at the upload, not at a Power
     Automate flow that was never going to fetch it. */
  console.log('— a workbook that has never arrived —');
  send(hoursAgo(3));
  click($('[data-nav="reconciliation"]'));
  t('says so plainly', d.body.textContent.indexOf('No PLX workbook has been uploaded yet') !== -1);
  t('and tells you where to do it', d.body.textContent.indexOf('On-Premise page') !== -1);
  t('offering a way there', !!$('.plx-bar [data-nav="coverage"]'));
  t('and never offers to fetch it from SharePoint', !$('[data-plx-refresh]'));
  t('rather than showing a bare zero', d.body.textContent.indexOf('0 shift tags') === -1);

  console.log('— a workbook that arrived, then stopped —');
  plxSync = { syncedAt: hoursAgo(40), shiftTags: 314, sites: 7, openOrders: 20 };
  await w.SuiteData.loadPlxSync().then(s => { w.GEODISSuite.state.plx.sync = s; });
  click($('[data-nav="overview"]'));
  click($('[data-nav="reconciliation"]'));
  t('the age is shown next to the counts', d.body.textContent.indexOf('40 hours ago') !== -1);
  t('and it is flagged as stale', d.body.textContent.indexOf('PLX workbook is') !== -1);
  t('the counts are still shown, not hidden', d.body.textContent.indexOf('314') !== -1);

  // Past two days it switches to days, which reads better than "73 hours".
  plxSync = { syncedAt: hoursAgo(73), shiftTags: 314, sites: 7, openOrders: 20 };
  await w.SuiteData.loadPlxSync().then(s => { w.GEODISSuite.state.plx.sync = s; });
  click($('[data-nav="overview"]'));
  click($('[data-nav="reconciliation"]'));
  t('beyond two days it reads in days', d.body.textContent.indexOf('3 days ago') !== -1);

  console.log('— a fresh workbook —');
  plxSync = { syncedAt: hoursAgo(2), shiftTags: 314, sites: 7, openOrders: 20 };
  await w.SuiteData.loadPlxSync().then(s => { w.GEODISSuite.state.plx.sync = s; });
  click($('[data-nav="overview"]'));
  click($('[data-nav="reconciliation"]'));
  t('no warning', d.body.textContent.indexOf('PLX workbook is') === -1);
  t('but the age is still stated', d.body.textContent.indexOf('2 hours ago') !== -1);

  /* The Beeline exports arrive in TWO emails, and the failure that actually
     happens is one Outlook rule breaking while the other keeps working: a board
     that looks current, carrying last week's candidates. So the halves are aged
     separately, not rolled into one "last synced". */
  console.log('— the emailed Beeline exports, before any flow runs —');
  const txt = () => d.body.textContent;
  const showReqs = async () => {
    await w.SuiteData.loadReqSync().then(s => { w.GEODISSuite.state.reqSync = s; });
    click($('[data-nav="overview"]'));
    click($('[data-nav="requisitions"]'));
  };
  await showReqs();
  t('says no export has arrived', txt().indexOf('No export has arrived by email yet') !== -1);
  t('and the manual import is still offered', !!$('[data-req-file]'));

  console.log('— both halves landed this morning —');
  reqSync = { syncedAt: hoursAgo(3), reqs: 110, candidates: 633,
    sources: { reqs: { fileName: 'Open Reqs.xlsx', receivedAt: hoursAgo(3), rowCount: 633 },
               candidates: { fileName: 'Cand.xlsx', receivedAt: hoursAgo(3), rowCount: 633 } } };
  await showReqs();
  t('both are named', txt().indexOf('GEODIS Open Reqs') !== -1 && txt().indexOf('Candidate Status per Req') !== -1);
  t('with their age', txt().indexOf('3 hours ago') !== -1);
  t('and no warning', txt().indexOf('It should refresh every morning') === -1);

  console.log('— one rule broke, the other kept working —');
  reqSync = { syncedAt: hoursAgo(3), reqs: 110, candidates: 633,
    sources: { reqs: { fileName: 'Open Reqs.xlsx', receivedAt: hoursAgo(3), rowCount: 633 },
               candidates: { fileName: 'Cand.xlsx', receivedAt: hoursAgo(50), rowCount: 610 } } };
  await showReqs();
  t('the stale half is flagged even though the import just ran',
    txt().indexOf('It should refresh every morning') !== -1);
  t('it says how old that half is', txt().indexOf('2 days ago') !== -1);
  t('the fresh half still reads as fresh', txt().indexOf('3 hours ago') !== -1);
  t('and the counts are still shown, not hidden', txt().indexOf('110 requests') !== -1);

  console.log('— a half that has never arrived at all —');
  reqSync = { syncedAt: hoursAgo(2), reqs: 110, candidates: 0,
    sources: { reqs: { fileName: 'Open Reqs.xlsx', receivedAt: hoursAgo(2), rowCount: 633 } } };
  await showReqs();
  t('named as never having arrived', txt().indexOf('has never arrived') !== -1);
  t('rather than being left off the list entirely', txt().indexOf('Candidate Status per Req') !== -1);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
