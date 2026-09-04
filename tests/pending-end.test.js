/* An assignment somebody has already decided to end.
 *
 * The reconciliation is a crosscheck of two overnight exports. When a
 * supervisor raises an end-assignment task today, RC is not updated until the
 * task is worked, and Beeline does not show the end until the export after
 * that -- so for a full day the row reads exactly like one nobody has looked
 * at. Two people then chase it, or the same person ends it twice.
 *
 * The open task is the missing evidence and only the suite holds it. This pins
 * it reaching the reconciliation table.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const html = fs.readFileSync(R + 'index.html', 'utf8').replace(/<script src="[^"]*"><\/script>/g, '');

/* Ava is MATCHED -- active in both systems, nothing for the crosscheck to say.
   That is the case that matters: the flag has to cut across the recommended
   action, not be one of them. Ben is already an exception; Cleo has no task. */
const snapshot = { updatedAt: '2026-09-04T11:30:00Z', counts: { total: 3, matched: 1 }, records: [
  { badge: '1001', empNumber: 'E1', person: 'Ava Reed', altName: '', action: 'matched', actionLabel: 'Matched',
    reason: 'Badge is active in both systems.', market: 'Atlanta', marketVerified: true, marketRaw: '',
    newBadge: null, crmStart: '1/5/2025', beeStart: '1/5/2025', endDate: '', endReason: '', dup: false },
  { badge: '1002', empNumber: '', person: 'Ben Ortiz', altName: '', action: 'endCrm', actionLabel: 'End in RC',
    reason: 'Beeline shows Terminated.', market: 'Atlanta', marketVerified: true, marketRaw: '',
    newBadge: null, crmStart: '2/1/2025', beeStart: '', endDate: '', endReason: '', dup: false },
  { badge: '1003', empNumber: 'E3', person: 'Cleo Nash', altName: '', action: 'addBeeline', actionLabel: 'Add to Beeline',
    reason: 'No record in Beeline.', market: 'Dallas', marketVerified: true, marketRaw: '',
    newBadge: null, crmStart: '3/3/2025', beeStart: '', endDate: '', endReason: '', dup: false }
]};

let tasks = [
  { id: 'TK-END-1', kind: 'terminate', title: 'End the assignment for Ava Reed',
    detail: 'Last day Friday.', badge: '1001', name: 'Ava Reed', market: 'Atlanta',
    assignee: 'Dana Cole', status: 'In Progress',
    createdAt: '2026-09-03T08:00:00Z', updatedAt: '2026-09-03T08:00:00Z' },
  // Finished, so it is history rather than a warning about today.
  { id: 'TK-END-2', kind: 'terminate', title: 'End the assignment for Cleo Nash',
    badge: '1003', name: 'Cleo Nash', market: 'Dallas', status: 'Complete',
    createdAt: '2026-08-20T08:00:00Z', updatedAt: '2026-08-21T08:00:00Z' },
  // A different kind of job about the same person must not read as an end.
  { id: 'TK-OTHER', kind: 'system', title: 'Add Ben Ortiz to Beeline',
    badge: '1002', name: 'Ben Ortiz', market: 'Atlanta', status: 'Open',
    createdAt: '2026-09-03T08:00:00Z', updatedAt: '2026-09-03T08:00:00Z' }
];

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window, d = w.document;
w.XLSX = { read() {}, utils: {} };
w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {}; w.prompt = () => null;
w.fetch = (url, opt) => {
  const u = String(url);
  if (opt && opt.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  if (u.includes('snapshot=1')) return Promise.resolve({ ok: true, json: () => Promise.resolve(snapshot) });
  if (u.includes('notes=1')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ notes: {} }) });
  if (u.includes('overrides=1')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ overrides: {} }) });
  if (u.includes('tasks=1')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ tasks: tasks }) });
  if (u.includes('plx=1') || u.includes('ilPto=1')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (u.includes('schedule=1')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ periods: [] }) });
  if (u.includes('coverage=1')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ coverage: {}, dates: [] }) });
  const k = (u.match(/\?(\w+)=1/) || [])[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions',
    performance: 'performance', shifts: 'shifts', discrepancies: 'discrepancies',
    associatePto: 'associatePto', locations: 'locations', appConfig: 'appConfig',
    timeclockLinks: 'timeclockLinks', contacts: 'contacts', reqCandidates: 'reqCandidates' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k] || k]: [] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'reconcile-core.js', 'suite-data.js', 'schedule-core.js',
 'shift-key.js', 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js',
 'contacts-core.js', 'reqs-core.js', 'pto-tracker-core.js'].forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
w.eval(html.match(/<script>\n"use strict";([\s\S]*?)<\/script>/)[1]);
w.eval(fs.readFileSync(R + 'suite.js', 'utf8'));

const $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = ms => new Promise(r => setTimeout(r, ms));
const rowFor = name => $$('#tbody tr').filter(r => r.textContent.indexOf(name) !== -1)[0];

(async () => {
  await settle(60);
  w.__setRole('manager');
  await settle(220);
  click($('[data-nav="reconciliation"]'));
  await settle(120);
  // Everything, so a matched row is on screen to be judged.
  const sel = d.getElementById('filterSelect');
  sel.value = 'all'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);

  console.log('— an end already decided, not yet in either export —');
  const ava = rowFor('Ava Reed');
  t('the row is on screen', !!ava);
  t('it still reads as Matched — the crosscheck has not seen the end yet',
    /Matched/.test(ava.textContent));
  t('but it is flagged as having an end task open', /End task open/.test(ava.textContent));
  t('with how long it has been waiting', /raised yesterday|raised \d+ days ago|raised today/.test(ava.textContent));
  t('and who has it', /Dana Cole/.test(ava.textContent));
  t('the flag says why Beeline has not caught up',
    /export/i.test(ava.querySelector('.end-pending').getAttribute('title')));

  console.log('— and only where it is actually true —');
  t('a completed end task is history, not a warning', !/End task open/.test(rowFor('Cleo Nash').textContent));
  t('a job of another kind is not read as an end', !/End task open/.test(rowFor('Ben Ortiz').textContent));

  console.log('— it can be worked as a set —');
  const endCard = $$('#stats .stat').filter(x => /End task open/.test(x.textContent))[0];
  t('a stat card counts them', !!endCard && endCard.querySelector('.v').textContent.trim() === '1');
  t('and the list can be narrowed to them',
    Array.from(d.getElementById('filterSelect').options).some(o => o.value === 'pendingEnd'));
  const f = d.getElementById('filterSelect');
  f.value = 'pendingEnd'; f.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  t('which shows the pending one and nothing else',
    $$('#tbody tr').length === 1 && /Ava Reed/.test($('#tbody').textContent));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
