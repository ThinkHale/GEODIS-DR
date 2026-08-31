/* Making a connection from the Settings → Connections list.

   Three ways this silently did nothing, all of which look identical to the person
   clicking:
     - signed in, but the account RECORD had not loaded, so it fell through to a
       browser prompt;
     - the prompt dismissed (or suppressed by the browser), returning null and
       taking a quiet `return`;
     - the save succeeding but the list never refreshing, so the person stayed on
       screen exactly as if nothing had happened. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

function harness(opts) {
  opts = opts || {};
  const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
   <div id="suite-root"></div><main id="recon-main"><div id="tbody">R</div></main></body></html>`,
    { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
  const w = dom.window;
  const alerts = [], prompts = [];
  let links = [];
  w.alert = m => alerts.push(m);
  w.confirm = () => true;
  w.scrollTo = () => {};
  w.prompt = m => { prompts.push(m); return opts.promptAnswer === undefined ? 'Typed Name' : opts.promptAnswer; };
  w.XLSX = { read: () => ({ SheetNames: [], Sheets: {} }), utils: { sheet_to_json: x => x } };
  w.fetch = (u, o) => {
    const s = String(u);
    if (o && o.method === 'POST') {
      const b = JSON.parse(o.body);
      if (s.indexOf('timeclockLinks=1') !== -1 && b.id) links.push(b);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    if (s.indexOf('timeclockLinks=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ timeclockLinks: links }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  ['auth-core.js', 'tests/suite-auth-stub.js', 'reconcile-core.js', 'suite-data.js', 'schedule-core.js',
   'shift-key.js', 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js',
   'contacts-core.js', 'reqs-core.js', 'suite.js'].forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
  const d = w.document;
  return {
    w, d, alerts, prompts, links: () => links,
    $: s => d.querySelector(s),
    $$: s => Array.from(d.querySelectorAll(s)),
    click: el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }))
  };
}

// One workbook person the roster spells differently: unconnected, no close match,
// so the row offers "Review…" and the search modal rather than a one-click.
function seed(h) {
  const st = h.w.GEODISSuite.state;
  st.storesLoaded = true;
  st.stores.shifts = [{ eid: '80-ZZOTHER111', name: 'Zzz, Totally Different', nameKey: 'totally different zzz', shift: '2nd', building: '1536' }];
  h.d.dispatchEvent(new h.w.CustomEvent('geodis:records', { detail: { records: [
    { badge: 'B2', person: 'Someone Else Entirely', empNumber: 'E2', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' }
  ] } }));
  st.admin.tab = 'connections';
  st.admin.loaded = true;
}
async function openAndPick(h) {
  h.w.GEODISSuite.go('settings');
  await new Promise(r => setTimeout(r, 40));
  const review = h.$('[data-link-eid]');
  if (!review) return { review: false };
  h.click(review);
  const box = h.$('#connect-search');
  box.value = 'Someone';
  box.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  const hit = h.$('[data-connect-to]');
  if (!hit) return { review: true, hit: false };
  h.click(hit);
  await new Promise(r => setTimeout(r, 150));
  return { review: true, hit: true };
}

(async () => {
  console.log('— signed in, before the account record has loaded —');
  {
    const h = harness();
    await new Promise(r => setTimeout(r, 60));
    seed(h);
    await new Promise(r => setTimeout(r, 40));
    // Signed in, but state.auth.account is null: the users list is admin-only and
    // may not have arrived. This used to fall through to the browser prompt.
    h.w.__setAuth({ signedIn: true, email: 'cody@geodis.com', account: null });
    await new Promise(r => setTimeout(r, 30));
    const r = await openAndPick(h);
    t('the row offers a search', r.review && r.hit);
    t('no name prompt is shown to somebody already signed in', h.prompts.length === 0);
    t('the connection is saved', h.links().length === 1);
    t('and attributed to the signed-in address', h.links()[0].linkedBy === 'cody@geodis.com');
  }

  console.log('— the name prompt dismissed —');
  {
    const h = harness({ promptAnswer: null });
    await new Promise(r => setTimeout(r, 60));
    seed(h);
    await new Promise(r => setTimeout(r, 40));
    await openAndPick(h);
    t('nothing is saved without somebody to attribute it to', h.links().length === 0);
    // The actual defect: this used to be a bare `return`.
    t('and it says so rather than doing nothing', h.alerts.length === 1);
    t('naming what went wrong', /not saved/i.test(h.alerts[0]) && /name/i.test(h.alerts[0]));
    t('and how to fix it', /sign in/i.test(h.alerts[0]));
  }

  console.log('— a saved connection leaves the list —');
  {
    const h = harness();
    await new Promise(r => setTimeout(r, 60));
    seed(h);
    await new Promise(r => setTimeout(r, 40));
    h.w.__setAuth({ signedIn: true, email: 'cody@geodis.com', account: { email: 'cody@geodis.com', name: 'Cody Hale', role: 'admin', enabled: true, markets: [] } });
    await new Promise(r => setTimeout(r, 30));
    h.w.GEODISSuite.go('settings');
    await new Promise(r => setTimeout(r, 40));
    t('the person is listed to start with', h.$$('.suite-table tbody tr').length === 1);
    await openAndPick(h);
    t('the connection is saved', h.links().length === 1);
    t('the timeclock id reaches the profile', h.w.GEODISSuite.profile('B2').timeclockId === '80-ZZOTHER111');
    // Without a rebuild the profile keeps its old id and the row stays put, which
    // is indistinguishable from the save having failed.
    t('and the row is gone from the list', h.$$('.suite-table tbody tr').length === 0);
    t('the modal is closed', !h.$('#suite-modal'));
    t('no alert, because nothing went wrong', h.alerts.length === 0);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
