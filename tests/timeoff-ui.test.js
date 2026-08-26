/* The Time Off page: the status pipeline as a dropdown, and connecting a request
   that arrived without a badge. */
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
  attendance: [], requisitions: [], performance: [], shifts: [],
  timeOff: [
    { id: 'FORM-1-0', badge: '215001', name: 'Luz Grachen', type: 'PTO', start: '2026-09-01', end: '2026-09-02',
      hours: 16, status: 'Received', source: 'Form (English)', submittedAt: '2026-08-24T09:00:00Z' },
    // Arrived from the form with a name typed differently -- no badge.
    { id: 'FORM-2-0', badge: '', name: 'Luiz Grachan', type: 'PTO', start: '2026-09-10', end: '2026-09-10',
      hours: 8, status: 'Received', source: 'Form (Spanish)' },
    // Written before the pipeline existed.
    { id: 'OLD-1', badge: '215002', name: '', type: 'PTO', start: '2026-08-01', end: '2026-08-01', hours: 8, status: 'Pending' }
  ]
};

const posts = [];
const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>h</header><main id="recon-main"><div id="tbody">R</div></main></body></html>`,
  { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
let promptReply = 'Cody Hale';
w.alert = m => posts.push({ alert: m });
w.confirm = () => true;
w.scrollTo = () => {};
w.prompt = (msg) => { posts.push({ prompt: msg }); return promptReply; };
w.XLSX = { read: () => ({ SheetNames: [], Sheets: {} }), utils: { sheet_to_json: x => x } };
w.fetch = (url, opt) => {
  const u = String(url);
  if (opt && opt.method === 'POST') {
    const body = JSON.parse(opt.body);
    posts.push({ url: u, body });
    if (u.indexOf('timeoff=1') !== -1 && body.id) {
      const i = stores.timeOff.findIndex(x => x.id === body.id);
      if (i !== -1) stores.timeOff[i] = Object.assign({}, stores.timeOff[i], body);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  }
  if (u.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (/schedule=1|coverage=1/.test(u)) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  const k = u.match(/\?(\w+)=1/)[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions', performance: 'performance', shifts: 'shifts', discrepancies: 'discrepancies' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: stores[map[k]] }) });
};
['suite-data.js', 'schedule-core.js', 'shift-key.js', 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'suite.js']
  .forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = ms => new Promise(r => setTimeout(r, ms));
const rowFor = name => $$('.suite-table tbody tr').find(tr => tr.textContent.indexOf(name) !== -1);

(async () => {
  await settle(60);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));
  click($('[data-nav="timeoff"]'));

  console.log('— the status is a pipeline, not Approve/Remove —');
  t('no Approve button any more', !d.body.textContent.match(/\bApprove\b(?!d)/));
  t('a status dropdown per row', $$('.status-select').length === 3);
  const sel = rowFor('Luz Grachen').querySelector('.status-select');
  t('all seven statuses offered', sel.querySelectorAll('option').length === 7);
  t('client approval is one of them',
    Array.from(sel.querySelectorAll('option')).some(o => o.textContent.indexOf('client approval') !== -1));
  t('payroll is one of them',
    Array.from(sel.querySelectorAll('option')).some(o => o.textContent.indexOf('payroll') !== -1));
  t('current status selected', sel.value === 'Received');

  console.log('— older "Pending" data still reads —');
  const old = rowFor('Abel Munoz').querySelector('.status-select');
  t('legacy Pending shows as Received', old.value === 'Received');
  t('and is not offered as a stray extra option', old.querySelectorAll('option').length === 7);

  console.log('— the attendance tie-in follows the pipeline —');
  t('Received is not yet excused', rowFor('Luz Grachen').textContent.indexOf('Not yet excused') !== -1);

  console.log('— changing a status —');
  sel.value = 'Sent for Client Approval';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  t('it asked who is making the change', posts.some(p => p.prompt && p.prompt.indexOf('Your name') !== -1));
  let post = posts.filter(p => p.url && p.url.indexOf('timeoff=1') !== -1).pop();
  t('the change was saved', !!post);
  t('with the new status', post.body.status === 'Sent for Client Approval');
  t('attributed', post.body.statusUpdatedBy === 'Cody Hale');
  t('and timestamped', !!post.body.statusUpdatedAt);
  t('a change log is written', Array.isArray(post.body.statusHistory));
  t('seeded with where it started', post.body.statusHistory[0].status === 'Received');
  t('then the change', post.body.statusHistory[1].status === 'Sent for Client Approval');
  t('the actor id is stored for when sign-in exists', 'byId' in post.body.statusHistory[1]);
  t('the name is only asked once', posts.filter(p => p.prompt).length === 1);

  const sel2 = rowFor('Luz Grachen').querySelector('.status-select');
  sel2.value = 'Approved';
  sel2.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  post = posts.filter(p => p.url && p.url.indexOf('timeoff=1') !== -1).pop();
  t('the trail accumulates', post.body.statusHistory.length === 3);
  t('now excused', rowFor('Luz Grachen').textContent.indexOf('Excused · 0 points') !== -1);
  t('who and when shown on the row', rowFor('Luz Grachen').textContent.indexOf('Cody Hale') !== -1);

  console.log('— an unmatched request —');
  const orphanRow = rowFor('Luiz Grachan');
  t('shown with the name from the form', !!orphanRow);
  t('flagged as unmatched', orphanRow.textContent.indexOf('Not matched to a profile') !== -1);
  t('a banner counts them', d.body.textContent.indexOf('could not be matched to an associate') !== -1);
  t('a Connect button is offered', !!orphanRow.querySelector('[data-connect]'));
  t('matched rows do not get one', !rowFor('Luz Grachen').querySelector('[data-connect]'));

  console.log('— connecting it —');
  click(orphanRow.querySelector('[data-connect]'));
  t('a picker opened', !!$('#connect-search'));
  t('prefilled with the name from the form', $('#connect-search').value === 'Luiz Grachan');
  t('which finds nothing, since it is misspelled', $('#connect-results').textContent.indexOf('No associate matches') !== -1);
  const box = $('#connect-search');
  box.value = 'grachen'; box.dispatchEvent(new w.Event('input', { bubbles: true }));
  t('searching the roster finds the right person', $$('.connect-hit').length === 1);
  t('showing the badge to confirm', $('.connect-hit').textContent.indexOf('215001') !== -1);
  t('the search box keeps focus while typing', d.activeElement.id === 'connect-search');
  box.value = 'z'; box.dispatchEvent(new w.Event('input', { bubbles: true }));
  t('search narrows live', $$('.connect-hit').length >= 1);
  box.value = 'grachen'; box.dispatchEvent(new w.Event('input', { bubbles: true }));

  click($('.connect-hit'));
  await settle(60);
  t('the picker closed', !$('#connect-search'));
  post = posts.filter(p => p.url && p.url.indexOf('timeoff=1') !== -1).pop();
  t('the badge was saved', post.body.badge === '215001');
  t('who linked it', post.body.connectedBy === 'Cody Hale');
  t('and when', !!post.body.connectedAt);
  t('the link is in the change log', post.body.statusHistory.some(e => (e.note || '').indexOf('Linked to badge 215001') !== -1));
  t('the status was not altered by linking', post.body.status === undefined);
  t('the row now resolves to the associate', !rowFor('Luiz Grachan'));
  t('and the banner is gone', d.body.textContent.indexOf('could not be matched to an associate') === -1);

  console.log('— cancelling the name prompt changes nothing —');
  promptReply = null;
  try { w.localStorage.removeItem('geodis.actorName'); } catch (e) {}
  const before = posts.filter(p => p.url && p.url.indexOf('timeoff=1') !== -1).length;
  const s3 = rowFor('Abel Munoz').querySelector('.status-select');
  s3.value = 'Denied';
  s3.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  t('no write without an actor', posts.filter(p => p.url && p.url.indexOf('timeoff=1') !== -1).length === before);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
