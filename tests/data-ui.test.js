/* The Data panel exports a scoped, complete LEGO roster and refuses to turn
   incomplete source data into an apparently authoritative spreadsheet. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const R = path.join(__dirname, '..');
const XLSX = require(require.resolve('xlsx', { paths: [R, path.join(R, 'functions')] }));
let passed = 0;
const t = (name, condition) => { assert.ok(condition, name); passed++; };
const settle = () => new Promise(resolve => setTimeout(resolve, 40));
const localDate = () => {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0');
};

const records = [
  { badge: '1001', person: 'Ann Reed', market: 'Chicago' },
  { badge: '1002', person: 'Ben Ortiz', market: 'Chicago', endDate: '2026-08-01' },
  { badge: '1003', person: 'Cal Quinn', market: 'St. Louis' },
  { badge: '1004', person: 'Cora Fox', market: 'Chicago' },
  { badge: '1005', person: 'Una Holt', market: 'Chicago' },
  { badge: '1006', person: 'Mira Ames', market: 'Chicago' },
  { badge: '1007', person: 'Dave Long', market: 'Chicago' }
].map(row => Object.assign({ action: 'matched', actionLabel: 'Matched', reason: '', marketVerified: true }, row));
const shifts = [
  { name: 'Reed, Ann', shift: '1st', building: '1519', account: 'LEGO SAH' },
  { name: 'Ortiz, Ben', shift: '2nd', building: '1519', account: 'LEGO SAH' },
  { name: 'Quinn, Cal', shift: '1st', building: '4400', account: 'LEGO' },
  { name: 'Fox, Cora', shift: '2nd', building: '1502', account: 'CCM' },
  // A shared building number alone must never establish that this is LEGO.
  { name: 'Holt, Una', shift: '1st', building: '1502', account: '' },
  { name: 'Ames, Mira', shift: '', building: '1519', account: 'LEGO SAH' },
  { name: 'Long, Dave', shift: 'A', building: '1519', account: 'LEGO SAH' }
].map((row, i) => Object.assign({ id: 'S' + i, source: 'PLX workbook' }, row));

async function fixture(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body class="suite-active">' +
    '<div id="suite-root"></div><header>legacy</header><main id="recon-main">' +
    '<div id="tbody">R</div></main></body></html>', {
    runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' + (options.route || '')
  });
  const w = dom.window, d = w.document, exports = [], posts = [];
  w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {}; w.prompt = () => null;
  w.XLSX = Object.assign({}, XLSX, { writeFile: (book, filename) => exports.push({ book, filename }) });
  const stores = { shifts: options.shifts || shifts, locations: [] };
  w.fetch = (url, opts = {}) => {
    const params = new URL(String(url), w.location.href).searchParams;
    if (opts.method === 'POST') {
      posts.push(String(url));
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    if (options.failShifts && params.has('shifts')) return Promise.reject(new Error('Shift source offline'));
    if (params.has('plx') || params.has('ilPto') || params.has('reqSync')) {
      return Promise.resolve({ ok: true, json: async () => ({ sync: {} }) });
    }
    const collection = Array.from(params.keys())[0];
    const key = collection === 'timeoff' ? 'timeOff' : collection;
    return Promise.resolve({ ok: true, json: async () => ({ [key]: stores[key] || [] }) });
  };
  const scripts = ['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js',
    'shift-key.js', 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js',
    'contacts-core.js', 'reqs-core.js', 'pto-tracker-core.js', 'roster-export-core.js', 'suite.js'];
  scripts.forEach(file => w.eval(fs.readFileSync(path.join(R, file), 'utf8')));
  await settle();
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records: options.records || records } }));
  await settle();
  const $ = selector => d.querySelector(selector);
  const $$ = selector => Array.from(d.querySelectorAll(selector));
  const click = node => {
    assert.ok(node, 'the requested control exists');
    node.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const change = (selector, value) => {
    const node = $(selector);
    assert.ok(node, selector + ' exists');
    node.value = value;
    node.dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  const exportText = () => {
    const last = exports[exports.length - 1];
    assert.ok(last, 'an Excel file was generated');
    return last.book.SheetNames.map(name => XLSX.utils.sheet_to_json(last.book.Sheets[name],
      { header: 1, defval: '' }).map(row => row.join('\t')).join('\n')).join('\n');
  };
  return { dom, w, d, $, $$, click, change, exports, posts, exportText };
}

(async () => {
  const f = await fixture();
  try {
    const { w, d, $, $$, click, change, exports, exportText } = f;
    console.log('— Data navigation and the LEGO export —');
    t('Data has a primary navigation entry', $$('[data-nav="data"]').some(node => node.textContent.trim() === 'Data'));
    click($('[data-nav="associates"]'));
    change('#status-filter', 'Ended');
    const search = $('#suite-search');
    search.value = 'a name that matches nobody';
    search.dispatchEvent(new w.Event('input', { bubbles: true }));
    const shortcut = $$('[data-nav="data"]').find(node => /Export LEGO roster/.test(node.textContent));
    t('Associates links directly to the export', !!shortcut);
    click(shortcut);
    t('the shortcut opens Data', w.GEODISSuite.state.view === 'data' && $('h1').textContent.trim() === 'Data');
    t('the initial status is Active', $('#data-roster-status').value === 'Active');
    t('all three assignment status choices are available',
      Array.from($('#data-roster-status').options).map(option => option.value).sort().join(',') === 'Active,Ended,all');
    t('the Excel action is enabled when sources are ready', !$('[data-roster-export]').disabled);
    t('the preview identifies unassigned shifts', /Unassigned/.test(d.body.textContent));
    t('unknown accounts are disclosed without guessing LEGO membership', /1 associate in this scope has no account recorded/.test(d.body.textContent));
    const preview = $$('.data-shift-table tbody tr').map(row => Array.from(row.cells).map(cell => cell.textContent));
    t('the preview identifies shift groups and their counts',
      preview.some(row => row[0] === '1st' && row[1] === '2') &&
      preview.some(row => row[0] === 'A' && row[1] === '1') &&
      preview.some(row => row[0] === 'Unassigned' && row[1] === '1'));
    click($('[data-roster-export]'));
    let output = exportText();
    t('active LEGO associates across markets are included',
      ['Ann Reed', 'Cal Quinn', 'Mira Ames', 'Dave Long'].every(name => output.includes(name)));
    t('the prior Associates search and Ended filter do not truncate Data exports',
      w.GEODISSuite.state.statusFilter === 'Ended' && /4 associates exported/.test($('[data-roster-feedback]').textContent));
    t('ended associates are excluded by default', !output.includes('Ben Ortiz'));
    t('CCM and unknown account associates are excluded', !output.includes('Cora Fox') && !output.includes('Una Holt'));
    t('the workbook separates shift groups into sheets', exports[0].book.SheetNames.length >= 4);
    t('the filename names scope, status, and local export date',
      exports[0].filename === 'LEGO_Associates_All_Markets_Active_' + localDate() + '.xlsx');
    t('successful export is announced visibly',
      $('[data-roster-feedback]').getAttribute('role') === 'status' && /4 associates exported/.test($('[data-roster-feedback]').textContent));
    t('an export does not write workforce records', f.posts.length === 0);

    console.log('— the chosen market and status apply to the downloaded file —');
    change('#market-picker', 'Chicago');
    click($('[data-roster-export]'));
    output = exportText();
    t('the market filter excludes other markets', output.includes('Ann Reed') && !output.includes('Cal Quinn'));
    t('the chosen market is named in the filename', exports[exports.length - 1].filename ===
      'LEGO_Associates_Chicago_Active_' + localDate() + '.xlsx');
    change('#data-roster-status', 'Ended');
    click($('[data-roster-export]'));
    output = exportText();
    t('Ended exports the ended LEGO associate only', output.includes('Ben Ortiz') &&
      !['Ann Reed', 'Cal Quinn', 'Mira Ames', 'Dave Long', 'Cora Fox'].some(name => output.includes(name)));
    t('the status filter is reflected in the URL', new URLSearchParams(w.location.search).get('status') === 'Ended');
    change('#data-roster-status', 'all');
    click($('[data-roster-export]'));
    output = exportText();
    t('All includes both active and ended LEGO associates', output.includes('Ann Reed') && output.includes('Ben Ortiz'));
    change('#market-picker', 'St. Louis');
    change('#data-roster-status', 'Ended');
    const beforeEmpty = exports.length;
    t('an empty scope disables the download', $('[data-roster-export]').disabled);
    click($('[data-roster-export]'));
    t('an empty scope creates no workbook', exports.length === beforeEmpty);

    console.log('— account access also scopes exports, including All markets —');
    change('#market-picker', 'all');
    change('#data-roster-status', 'Active');
    w.__setAuth({ account: { email: 'reader@geodis.com', name: 'Reader', role: 'viewer', enabled: true, markets: ['Chicago'] } });
    await settle();
    t('a read-only account may export data it can view', !$('[data-roster-export]').disabled);
    click($('[data-roster-export]'));
    output = exportText();
    t('All markets still respects account market restrictions', output.includes('Ann Reed') && !output.includes('Cal Quinn'));
    t('a read-only export does not write source records', f.posts.length === 0);
    w.GEODISSuite.profile('1007').marketVerified = false;
    click($('[data-roster-export]'));
    t('an unverified market cannot establish account authorization', !exportText().includes('Dave Long'));
    w.GEODISSuite.profile('1007').marketVerified = true;
    change('#market-picker', 'St. Louis');
    t('selecting an unauthorized market cannot enable export', $('[data-roster-export]').disabled);
    change('#market-picker', 'all');

    console.log('— incomplete inputs and download failures remain visible —');
    const originalSourceState = w.SuiteData.getSourceState;
    for (const required of ['shifts', 'locations', 'timeclockLinks']) {
      for (const status of ['loading', 'refreshing', 'error', 'stale', 'denied']) {
        w.SuiteData.getSourceState = source => Object.assign({}, originalSourceState(source),
          source === required ? { status, error: { message: 'Source unavailable' } } : {});
        w.GEODISSuite.go('data');
        const before = exports.length;
        t('a ' + status + ' ' + required + ' source disables export', $('[data-roster-export]').disabled);
        click($('[data-roster-export]'));
        t('a ' + status + ' ' + required + ' source cannot generate a file', exports.length === before);
      }
    }
    w.SuiteData.getSourceState = originalSourceState;
    w.GEODISSuite.state.storesLoaded = false;
    w.GEODISSuite.go('data');
    t('initial collection loading disables export', $('[data-roster-export]').disabled);
    w.GEODISSuite.state.storesLoaded = true;
    const browserXlsx = w.XLSX;
    delete w.XLSX;
    w.GEODISSuite.go('data');
    t('a missing spreadsheet library disables export', $('[data-roster-export]').disabled);
    w.XLSX = browserXlsx;
    w.GEODISSuite.go('data');
    const originalWorkbook = w.RosterExportCore.workbook;
    w.RosterExportCore.workbook = () => { throw new Error('Workbook creation failed'); };
    click($('[data-roster-export]'));
    t('workbook creation errors are visible', /Workbook creation failed/.test($('[data-roster-feedback]').textContent));
    t('error feedback is available to assistive technology', $('[data-roster-feedback]').getAttribute('role') === 'status');
    w.RosterExportCore.workbook = originalWorkbook;
    const originalWriteFile = w.XLSX.writeFile;
    w.XLSX.writeFile = () => { throw new Error('Download failed'); };
    click($('[data-roster-export]'));
    t('file writing errors are visible', /Download failed/.test($('[data-roster-feedback]').textContent));
    w.XLSX.writeFile = originalWriteFile;

    console.log('— access is rechecked when an old button is clicked —');
    const beforeDenied = exports.length;
    w.GEODISSuite.state.auth.account.enabled = false;
    click($('[data-roster-export]'));
    t('a disabled account cannot export from a stale render', exports.length === beforeDenied);
    w.GEODISSuite.state.auth.account.enabled = true;
    w.GEODISSuite.state.auth.signedIn = false;
    click($('[data-roster-export]'));
    t('a signed-out account cannot export from a stale render', exports.length === beforeDenied);
    w.__setAuth({ signedIn: false, email: '', account: null });
    t('signed-out users have no export control', !$('[data-roster-export]'));
    t('signed-out users see the sign-in gate', !!$('[data-signin]'));
  } finally { f.dom.window.close(); }

  console.log('— bookmarked filters restore on load and browser navigation —');
  const routed = await fixture({ route: '?view=data&market=Chicago&status=Ended' });
  try {
    t('a bookmark opens the Data panel', routed.w.GEODISSuite.state.view === 'data');
    t('a bookmark restores status and market', routed.$('#data-roster-status').value === 'Ended' &&
      routed.$('#market-picker').value === 'Chicago');
    routed.click(routed.$('[data-roster-export]'));
    t('a bookmarked export honors its filters', routed.exportText().includes('Ben Ortiz') && !routed.exportText().includes('Ann Reed'));
    routed.w.history.pushState({}, '', '?view=data&market=St.%20Louis&status=Active');
    routed.w.dispatchEvent(new routed.w.PopStateEvent('popstate'));
    t('browser navigation restores Data filters', routed.$('#data-roster-status').value === 'Active' &&
      routed.$('#market-picker').value === 'St. Louis');
  } finally { routed.dom.window.close(); }

  console.log('— a large roster exports all matching associates —');
  const largeRecords = Array.from({ length: 275 }, (_, i) => Object.assign({}, records[0], {
    badge: String(5000 + i), person: 'Associate ' + String(i).padStart(3, '0')
  }));
  const largeShifts = largeRecords.map(row => ({ id: 'S' + row.badge, name: row.person,
    shift: '1st', building: '1519', account: 'LEGO SAH', source: 'PLX workbook' }));
  const large = await fixture({ route: '?view=data', records: largeRecords, shifts: largeShifts });
  try {
    large.click(large.$('[data-roster-export]'));
    const book = large.exports[0].book;
    const rows = XLSX.utils.sheet_to_json(book.Sheets['1st'], { header: 1 });
    t('a roster larger than the screen limit exports every associate', rows.length === 276);
    t('the final associate is present in the download', large.exportText().includes('Associate 274'));
    t('the displayed count agrees with the file', /275 associates exported/.test(large.$('[data-roster-feedback]').textContent));
  } finally { large.dom.window.close(); }

  console.log('— a failed initial roster source cannot be exported —');
  const failed = await fixture({ route: '?view=data', failShifts: true });
  try {
    t('a source failure remains recorded', failed.w.SuiteData.getSourceState('shifts').status === 'error');
    t('the first-load failure disables export', failed.$('[data-roster-export]').disabled);
    t('the panel explains that data could not load', /load|unavailable|retry/i.test(failed.d.body.textContent));
    failed.click(failed.$('[data-roster-export]'));
    t('a failed first load creates no workbook', failed.exports.length === 0);
  } finally { failed.dom.window.close(); }

  console.log('\n' + passed + ' passed, 0 failed');
})().catch(err => { console.error(err); process.exitCode = 1; });
