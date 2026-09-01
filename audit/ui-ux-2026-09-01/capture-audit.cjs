const { chromium } = require('/tmp/geodis-audit-pw/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const OUT = __dirname;
const ROOT = path.resolve(__dirname, '../..');
const p2 = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const day = n => { const d = new Date(2026, 8, 1); d.setDate(d.getDate() + n); return iso(d); };

const records = [
  { badge: '215001', empNumber: '80-LGRACH1', person: 'Luz Grachen', action: 'matched', actionLabel: 'Matched', reason: 'Active in both systems.', market: 'Chicago', marketVerified: true, crmStart: '1/5/2025', beeStart: '1/5/2025', assignmentId: 'a5801' },
  { badge: '215002', empNumber: '80-AMUNOZ2', person: 'Abel Munoz', action: 'matched', actionLabel: 'Matched', reason: 'Active in both systems.', market: 'Chicago', marketVerified: true, crmStart: '2/1/2025', beeStart: '2/1/2025', assignmentId: 'a5802' },
  { badge: '215003', empNumber: '80-NNEW3', person: 'Nate New', action: 'addBeeline', actionLabel: 'Add to Beeline', reason: 'No active Beeline assignment.', market: 'Chicago', marketVerified: true, crmStart: '8/25/2026', beeStart: '', assignmentId: 'a5803' },
  { badge: '215004', empNumber: '80-CNASH4', person: 'Cleo Nash', action: 'endCrm', actionLabel: 'End in RC', reason: 'Beeline shows Terminated.', market: 'Chicago', marketVerified: true, crmStart: '3/3/2025', beeStart: '', assignmentId: 'a5804' },
  { badge: '315001', empNumber: '80-SLOU1', person: 'Sam Lou', action: 'matched', actionLabel: 'Matched', reason: 'Active in both systems.', market: 'St. Louis', marketVerified: true, crmStart: '4/2/2025', beeStart: '4/2/2025', assignmentId: 'a5811' },
  { badge: '315002', empNumber: '80-MCLARK2', person: 'Mia Clark', action: 'addCrm', actionLabel: 'Add to RC', reason: 'Active in Beeline with no RC assignment.', market: 'St. Louis', marketVerified: true, crmStart: '', beeStart: '6/3/2026' },
  { badge: '315003', empNumber: '80-ZADAMS3', person: 'Zoe Adams', action: 'matched', actionLabel: 'Matched', reason: 'Active in both systems.', market: 'St. Louis', marketVerified: true, crmStart: '5/8/2025', beeStart: '5/8/2025' },
  { badge: '415001', empNumber: '80-UNKNOWN', person: 'Dev Patel', action: 'endBeeline', actionLabel: 'End in Beeline', reason: 'RC assignment has ended.', market: 'Other', marketVerified: false, marketRaw: 'MEMPHIS', endDate: '2026-08-28', endReason: 'Voluntary' }
];

const stores = {
  attendance: [
    { id: 'A1', badge: '215001', date: day(-1), type: 'Absent', points: 1, notes: 'No call before shift.' },
    { id: 'A2', badge: '215001', date: day(-8), type: 'Late', points: 0.5, notes: '18 minutes late.' },
    { id: 'A3', badge: '215002', date: day(-2), type: 'No Call / No Show', points: 2, notes: 'Supervisor follow-up required.' },
    { id: 'A4', badge: '215003', date: day(-3), type: 'Absent', points: 6, notes: 'Documentation pending.' },
    { id: 'A5', badge: '315001', date: day(-1), type: 'Present', points: 0 },
    { id: 'A6', badge: '315002', date: day(-4), type: 'Early Out', points: 0.5 },
    { id: 'A7', badge: '', name: 'Unmatched, Person', date: day(-1), type: 'Absent', points: 1 }
  ],
  timeOff: [
    { id: 'TO1', badge: '215001', name: 'Luz Grachen', type: 'PTO', start: day(2), end: day(3), hours: 16, status: 'Received', source: 'Form (English)', submittedAt: '2026-08-30T09:00:00Z' },
    { id: 'TO2', badge: '215002', name: 'Abel Munoz', type: 'VTO', start: day(5), end: day(5), hours: 8, status: 'Sent for Client Approval', source: 'Form (Spanish)', submittedAt: '2026-08-29T14:00:00Z' },
    { id: 'TO3', badge: '215003', name: 'Nate New', type: 'PTO', start: day(0), end: day(0), hours: 8, status: 'Approved', source: 'IL Shared PTO Tracker', submittedAt: '2026-08-25T12:00:00Z' },
    { id: 'TO4', badge: '315001', name: 'Sam Lou', type: 'PTO', start: day(-10), end: day(-10), hours: 8, status: 'Completed', source: 'IL Shared PTO Tracker' },
    { id: 'TO5', badge: '', name: 'Luiz Grachan', type: 'PTO', start: day(7), end: day(7), hours: 8, status: 'Received', source: 'Form (English)' }
  ],
  requisitions: [
    { id: 'REQ-100', beelineReq: 'CHI-100', beelineStatus: 'Open', beelineOpenings: 12, hired: 5, submitted: 9, offered: 3, declined: 1, jobPosition: 'Material Handler', market: 'Chicago', startDate: day(14), hiringManager: 'A. Manager', locationName: '1519 - Lego Main' },
    { id: 'REQ-101', beelineReq: 'CHI-101', beelineStatus: 'Open', beelineOpenings: 6, hired: 6, submitted: 8, offered: 6, declined: 2, jobPosition: 'Forklift Operator', market: 'Chicago', startDate: day(6), hiringManager: 'B. Manager', locationName: '1523 - Redbull' },
    { id: 'REQ-200', beelineReq: 'STL-200', beelineStatus: 'Open', beelineOpenings: 10, hired: 2, submitted: 4, offered: 2, declined: 0, jobPosition: 'Warehouse Associate', market: 'St. Louis', startDate: day(21), hiringManager: 'C. Manager', locationName: '1541 - STL Main' },
    { id: 'REQ-300', source: 'PLX workbook', title: 'Loader', openings: 4, filled: 0, status: 'Open', market: 'Chicago', building: '1536', shift: '2nd' },
    { id: 'REQ-M1', source: 'Added by hand', title: 'Inventory Clerk', openings: 2, filled: 0, status: 'Open', market: 'Chicago', building: '1519', shift: '1st' }
  ],
  reqCandidates: [
    { id: 'C1', reqId: 'CHI-100', name: 'Isaiah Montoya', beelineId: 'IMontoya0006', status: 'Offer Confirmed', stage: 'hired' },
    { id: 'C2', reqId: 'CHI-100', name: 'Maria Albarran', beelineId: 'MAlbarran6728', status: 'Offer Pending', stage: 'offered' },
    { id: 'C3', reqId: 'CHI-100', name: 'Dana Wells', beelineId: 'DWells8891', status: 'Pending', stage: 'review' },
    { id: 'C4', reqId: 'STL-200', name: 'Harold Holmes', beelineId: 'HHolmes9810', status: 'Pending', stage: 'review' }
  ],
  performance: [
    { id: 'P1', badge: '215001', period: '2026-08', quality: 96, productivity: 90, safety: 99 },
    { id: 'P2', badge: '215002', period: '2026-08', quality: 88, productivity: 83, safety: 95 },
    { id: 'P3', badge: '215003', period: '2026-08', quality: 70, productivity: 76, safety: 90 },
    { id: 'P4', badge: '315001', period: '2026-08', quality: 94, productivity: 92, safety: 100 }
  ],
  shifts: [
    { id: 'S1', name: 'Grachen, Luz', nameKey: 'grachen luz', eid: '80-LGRACH1', shift: '1st', building: '1519', account: 'LEGO SAH', hours: '12am-11:59pm Sun-Sat', source: 'PLX workbook' },
    { id: 'S2', name: 'Munoz, Abel', nameKey: 'abel munoz', eid: '80-AMUNOZ2', shift: '1st', building: '1519', account: 'LEGO SAH', hours: '12am-11:59pm Sun-Sat', source: 'PLX workbook' },
    { id: 'S3', name: 'New, Nate', nameKey: 'nate new', eid: '80-NNEW3', shift: '2nd', building: '1523', account: 'REDBULL', hours: '12am-11:59pm Sun-Sat', source: 'PLX workbook' },
    { id: 'S4', name: 'Nash, Cleo', nameKey: 'cleo nash', eid: '80-CNASH4', shift: '2nd', building: '1523', account: 'REDBULL', hours: '12am-11:59pm Sun-Sat', source: 'PLX workbook' },
    { id: 'S5', name: 'Lou, Sam', nameKey: 'lou sam', eid: '80-SLOU1', shift: 'A', building: '1541', account: 'STL MAIN', hours: '12am-11:59pm Sun-Sat', source: 'PLX workbook' },
    { id: 'S6', name: 'Clark, Mia', nameKey: 'clark mia', eid: '80-MCLARK2', shift: 'B', building: '1541', account: 'STL MAIN', hours: '12am-11:59pm Sun-Sat', source: 'PLX workbook' }
  ],
  discrepancies: [
    { id: 'D1', badge: '215001', name: 'Luz Grachen', location: 'LEGO', date: day(-7), weekEnding: day(-2), details: 'Missing 4 hours Tuesday', status: 'Received', submittedAt: '2026-08-25T10:00:00Z' },
    { id: 'D2', badge: '215002', name: 'Abel Munoz', location: 'LEGO', date: day(-3), weekEnding: day(5), details: 'Shift differential not applied', status: 'In Review', submittedAt: '2026-08-29T08:00:00Z' },
    { id: 'D3', badge: '', name: 'Luiz Grachan', location: 'Redbull', date: day(0), weekEnding: day(5), details: 'Overtime not paid', status: 'Received' }
  ],
  tasks: [
    { id: 'T1', kind: 'payroll', title: 'Chase missing overtime', detail: 'Verify Saturday punch against Beeline.', badge: '215002', name: 'Abel Munoz', market: 'Chicago', status: 'Open', createdAt: '2026-08-31T02:00:00Z', updatedAt: '2026-08-31T02:00:00Z' },
    { id: 'T2', kind: 'system', title: 'Add Nate to Beeline', detail: 'Active RC assignment has no Beeline record.', badge: '215003', name: 'Nate New', market: 'Chicago', status: 'Open', createdAt: '2026-08-29T08:00:00Z', updatedAt: '2026-08-29T08:00:00Z' },
    { id: 'T3', kind: 'note', title: 'Confirm first-day orientation', detail: 'Call site lead before second shift.', badge: '315002', name: 'Mia Clark', market: 'St. Louis', status: 'In Progress', createdAt: '2026-08-31T16:00:00Z', updatedAt: '2026-08-31T18:00:00Z' },
    { id: 'T4', kind: 'attendance', title: 'Collect attendance documentation', detail: 'Doctor note expected.', badge: '215003', name: 'Nate New', market: 'Chicago', status: 'Complete', createdAt: '2026-08-20T08:00:00Z', updatedAt: '2026-08-23T10:00:00Z' }
  ],
  contacts: [
    { id: 'PH-215001', badge: '215001', phone: '7736395639', source: 'PLX workbook' },
    { id: 'PH-215002', badge: '215002', phone: '6303800838', source: 'Entered by hand' }
  ],
  associatePto: [
    { id: 'AP1', badge: '215001', transitionAssociate: 'true', transitionPtoInitial: 24, transitionPtoBalance: 16 },
    { id: 'AP2', badge: '215002', transitionAssociate: 'false', transitionPtoInitial: 0, transitionPtoBalance: 0 }
  ],
  locations: [
    { id: 'L1', code: '1519', name: 'Lego Main', market: 'Chicago', active: true },
    { id: 'L2', code: '1523', name: 'Redbull', market: 'Chicago', active: true },
    { id: 'L3', code: '1541', name: 'STL Main', market: 'St. Louis', active: true }
  ],
  appConfig: [
    { id: 'CFG1', key: 'rcBaseUrl', value: 'https://example.my.salesforce.com' },
    { id: 'CFG2', key: 'rcAssignmentObject', value: 'TR1__Closing_Report__c' },
    { id: 'CFG3', key: 'attendanceWorkbookUrl', value: 'https://example.sharepoint.com/attendance' },
    { id: 'CFG4', key: 'ptoWorkbookUrl', value: 'https://example.sharepoint.com/pto' }
  ],
  timeclockLinks: [{ id: 'TC1', badge: '215003', eid: '80-NNEW3' }]
};

const admin = {
  users: [
    { id: 'tester@geodis.com', email: 'tester@geodis.com', name: 'Test Administrator', role: 'admin', enabled: true, markets: [], lastSeenAt: '2026-09-01T08:00:00Z' },
    { id: 'mgr@geodis.com', email: 'mgr@geodis.com', name: 'Chicago Manager', role: 'manager', enabled: true, markets: ['Chicago'], lastSeenAt: '2026-08-31T17:00:00Z' },
    { id: 'col@geodis.com', email: 'col@geodis.com', name: 'Operations Colleague', role: 'colleague', enabled: true, markets: [], lastSeenAt: '2026-08-30T12:00:00Z' },
    { id: 'agency@employbridge.com', email: 'agency@employbridge.com', name: 'Agency Viewer', role: 'viewer', enabled: false, markets: ['St. Louis'], lastSeenAt: '2026-08-20T09:00:00Z' }
  ],
  locations: stores.locations,
  shiftTypes: [
    { id: 'SH1', key: '1st', label: 'First shift', location: '1519', hours: '6:00am–2:30pm', active: true },
    { id: 'SH2', key: '2nd', label: 'Second shift', location: '1523', hours: '2:30pm–11:00pm', active: true },
    { id: 'SH3', key: 'A', label: 'A shift', location: '1541', hours: '6:00am–6:00pm', active: true }
  ],
  appConfig: stores.appConfig
};

const payrollPeriod = {
  weekEnding: '2026-08-30', closesAt: '2026-09-01T17:00:00Z',
  snapshots: [
    { takenAt: '2026-08-31T09:00:00Z', summary: { totalHours: 238, people: 6, net: 0 } },
    { takenAt: '2026-09-02T15:00:00Z', summary: { totalHours: 220, people: 6, net: -18 } }
  ],
  changes: [
    { kind: 'changed', badge: '215001', name: 'Luz Grachen', from: 40, to: 44, delta: 4, at: '2026-09-02T15:00:00Z', afterClose: true },
    { kind: 'removed', badge: '215002', name: 'Abel Munoz', from: 38, to: 0, delta: -38, at: '2026-09-02T15:00:00Z', afterClose: true },
    { kind: 'added', badge: '215003', name: 'Nate New', from: 0, to: 16, delta: 16, at: '2026-08-31T09:00:00Z', afterClose: false }
  ]
};

const json = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'light' });
  const page = await context.newPage();
  const problems = [];
  page.on('console', msg => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });
  page.on('pageerror', err => problems.push(`pageerror: ${err.message}`));

  const authStub = fs.readFileSync(path.join(ROOT, 'tests/suite-auth-stub.js'), 'utf8')
    .replace("role: 'colleague'", "role: 'admin'")
    .replace("name: 'Tester'", "name: 'Test Administrator'");
  await page.route('**/suite-auth.js', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: authStub }));
  await page.route('https://syncreport-eusvh7xq5q-uc.a.run.app/**', async route => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fulfill(json({ ok: true }));
    const u = new URL(req.url());
    if (u.searchParams.has('snapshot')) return route.fulfill(json({ updatedAt: '2026-09-01T10:30:00Z', counts: { total: records.length, matched: 4 }, records }));
    if (u.searchParams.has('notes')) return route.fulfill(json({ notes: { '215003': { note: 'Waiting on Beeline setup.' } } }));
    if (u.searchParams.has('overrides')) return route.fulfill(json({ overrides: {} }));
    if (u.searchParams.has('plx')) return route.fulfill(json({ sync: { syncedAt: '2026-09-01T09:15:00Z', fileName: 'GEODIS PLX.xlsx', attendance: 7, shifts: 6, requisitions: 1 } }));
    if (u.searchParams.has('ilPto')) return route.fulfill(json({ sync: { syncedAt: '2026-09-01T08:40:00Z', fileName: 'IL Shared PTO Tracker.xlsx', rows: 5 } }));
    if (u.searchParams.has('reqSync')) return route.fulfill(json({ sync: { syncedAt: '2026-09-01T07:10:00Z', reqs: 3, candidates: 4, missing: [], sources: { reqs: { fileName: 'GEODIS Open Reqs.xlsx' }, candidates: { fileName: 'Candidate Status per Req.xlsx' } } } }));
    if (u.searchParams.has('payroll')) {
      if (u.searchParams.has('week')) return route.fulfill(json({ period: payrollPeriod }));
      return route.fulfill(json({ periods: ['2026-08-30'] }));
    }
    if (u.searchParams.has('coverage')) return route.fulfill(json({ dates: [], coverage: {} }));
    if (u.searchParams.has('schedule')) return route.fulfill(json({ schedule: null }));
    for (const key of Object.keys(admin)) {
      if (u.searchParams.has(key) && ['users', 'shiftTypes'].includes(key)) return route.fulfill(json({ [key]: admin[key] }));
    }
    if (u.searchParams.has('locations')) return route.fulfill(json({ locations: stores.locations }));
    if (u.searchParams.has('appConfig')) return route.fulfill(json({ appConfig: stores.appConfig }));
    for (const [query, prop] of Object.entries({ attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions', performance: 'performance', shifts: 'shifts', discrepancies: 'discrepancies', associatePto: 'associatePto', timeclockLinks: 'timeclockLinks', tasks: 'tasks', contacts: 'contacts', reqCandidates: 'reqCandidates' })) {
      if (u.searchParams.has(query)) return route.fulfill(json({ [prop]: stores[prop] }));
    }
    return route.fulfill(json({ ok: true }));
  });

  await page.goto('http://127.0.0.1:4173/index.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('.suite-nav');
  await page.waitForTimeout(500);

  async function shot(name, opts = {}) {
    await page.waitForTimeout(opts.wait || 180);
    const file = path.join(OUT, name + '.png');
    await page.screenshot({ path: file, fullPage: opts.fullPage !== false, animations: 'disabled' });
    const title = await page.locator('.suite-heading h1, .gate-card h1').first().textContent().catch(() => '');
    const size = fs.statSync(file).size;
    process.stdout.write(`${name}\t${title || ''}\t${size}\n`);
  }
  async function go(view) {
    await page.evaluate(v => window.GEODISSuite.go(v), view);
    await page.waitForTimeout(120);
  }

  await shot('01-overview');
  await go('tasks'); await shot('02-tasks');
  await go('associates'); await shot('03-associates');
  await page.locator('[data-profile="215001"]').click(); await shot('04-associate-profile');

  await page.evaluate(() => {
    const st = window.GEODISSuite.state;
    st.coverage.presence = window.ScheduleCore.parseOnPremise([
      ['Employee Full Name & ID', 'On Premises', 'Primary location (path)', 'Reports To'],
      ['Grachen, Luz (80-LGRACH1)', 'true', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1519/1519', 'Boss, Bea'],
      ['Munoz, Abel (80-AMUNOZ2)', 'false', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1519/1519', 'Boss, Bea'],
      ['New, Nate (80-NNEW3)', 'false', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1523/1523', 'Lead, Lee'],
      ['Nash, Cleo (80-CNASH4)', 'false', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1523/1523', 'Lead, Lee'],
      ['Extra, Eli (80-EELI1)', 'true', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1523/1523', 'Lead, Lee']
    ]);
    st.coverage.asOf = new Date('2026-09-01T10:45:00');
    st.coverage.presenceFile = 'On Premise - Simple_2026-09-01T10_45.csv';
    st.coverage.statusFilter = 'all';
    window.GEODISSuite.go('coverage');
  });
  await shot('05-on-premise');
  await go('attendance'); await shot('06-attendance');
  await go('timeoff'); await shot('07-time-off');
  await go('payroll'); await shot('08-payroll-discrepancies');
  await page.locator('[data-payroll-tab="hours"]').click(); await page.waitForTimeout(400); await shot('09-payroll-hours');
  await go('requisitions'); await shot('10-beeline-requests');
  await go('reconciliation'); await shot('11-assignment-reconciliation');
  await go('settings'); await shot('12-settings-account');
  for (const [tab, name] of [['users', '13-settings-users'], ['connections', '14-settings-connections'], ['locations', '15-settings-locations'], ['shifts', '16-settings-shifts'], ['links', '17-settings-app']]) {
    await page.locator(`[data-settings-tab="${tab}"]`).click();
    await page.waitForTimeout(250);
    await shot(name);
  }
  await go('overview');
  await page.locator('[data-add-task]').click();
  await shot('18-add-task-modal', { fullPage: false });
  await page.keyboard.press('Escape');

  const keyboard = await page.evaluate(async () => {
    const selectors = ['.suite-nav-btn', '.suite-add', '.suite-select', '.suite-btn'];
    return selectors.map(s => {
      const el = document.querySelector(s);
      if (!el) return { selector: s, present: false };
      el.focus();
      const cs = getComputedStyle(el);
      return { selector: s, present: true, outline: cs.outline, boxShadow: cs.boxShadow, focused: document.activeElement === el };
    });
  });

  await page.evaluate(() => window.__setAuth({ ready: true, signedIn: false, email: '', account: null }));
  await shot('19-sign-in', { fullPage: false });

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, colorScheme: 'light' });
  const mp = await mobile.newPage();
  await mp.route('**/suite-auth.js', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: authStub }));
  await mp.route('https://syncreport-eusvh7xq5q-uc.a.run.app/**', async route => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fulfill(json({ ok: true }));
    const u = new URL(req.url());
    if (u.searchParams.has('snapshot')) return route.fulfill(json({ updatedAt: '2026-09-01T10:30:00Z', records }));
    if (u.searchParams.has('notes')) return route.fulfill(json({ notes: {} }));
    if (u.searchParams.has('overrides')) return route.fulfill(json({ overrides: {} }));
    if (/plx|ilPto|reqSync/.test(u.search)) return route.fulfill(json({ sync: {} }));
    if (/payroll|coverage|schedule/.test(u.search)) return route.fulfill(json({}));
    for (const [query, prop] of Object.entries({ attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions', performance: 'performance', shifts: 'shifts', discrepancies: 'discrepancies', associatePto: 'associatePto', locations: 'locations', appConfig: 'appConfig', timeclockLinks: 'timeclockLinks', tasks: 'tasks', contacts: 'contacts', reqCandidates: 'reqCandidates' })) {
      if (u.searchParams.has(query)) return route.fulfill(json({ [prop]: stores[prop] || [] }));
    }
    return route.fulfill(json({ ok: true }));
  });
  await mp.goto('http://127.0.0.1:4173/index.html', { waitUntil: 'networkidle' });
  await mp.waitForSelector('.suite-nav');
  await mp.waitForTimeout(400);
  await mp.screenshot({ path: path.join(OUT, '20-mobile-overview.png'), fullPage: false, animations: 'disabled' });
  const mobileNav = await mp.evaluate(() => Array.from(document.querySelectorAll('.suite-nav-btn')).map(el => {
    const r = el.getBoundingClientRect();
    return { nav: el.dataset.nav, top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.bottom > 0 && r.top < innerHeight };
  }));
  await mobile.close();

  const evidence = {
    capturedAt: new Date().toISOString(),
    viewport: { width: 1440, height: 1000 },
    screenshots: fs.readdirSync(OUT).filter(x => x.endsWith('.png')).sort(),
    keyboard,
    mobileNav,
    problems
  };
  fs.writeFileSync(path.join(OUT, 'capture-evidence.json'), JSON.stringify(evidence, null, 2));
  process.stdout.write(JSON.stringify({ keyboard, mobileNav, problems }, null, 2) + '\n');
  await context.close();
  await browser.close();
}

main().catch(err => { console.error(err); process.exitCode = 1; });
