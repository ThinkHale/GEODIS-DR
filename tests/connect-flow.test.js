/* Making a connection from the Settings → Connections list.

   Ways this silently did nothing, all of which look identical to the person
   clicking:
     - the save succeeding but the list never refreshing, so the person stayed on
       screen exactly as if nothing had happened;
     - an account that may not do it being shown the control anyway, and the
       refusal arriving as a status code nobody sees.

   The two prompt-related failures this file used to cover are gone with the
   prompt: there is no browser-name fallback any more, because the suite does not
   render at all without a signed-in account. */
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
  let links = (opts.links || []).slice();
  w.alert = m => alerts.push(m);
  w.confirm = () => true;
  w.scrollTo = () => {};
  // A prompt firing at all is a failure now, so it is recorded, never answered.
  w.prompt = m => { prompts.push(m); return null; };
  w.XLSX = { read: () => ({ SheetNames: [], Sheets: {} }), utils: { sheet_to_json: x => x } };
  w.fetch = (u, o) => {
    const s = String(u);
    if (o && o.method === 'POST') {
      const b = JSON.parse(o.body);
      if (s.indexOf('timeclockLinks=1') !== -1 && b.id) {
        if (b._delete) links = links.filter(x => x.id !== b.id);
        else links.push(b);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    if (s.indexOf('timeclockLinks=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ timeclockLinks: links }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  ['auth-core.js', 'tests/suite-auth-stub.js', 'reconcile-core.js', 'suite-data.js', 'schedule-core.js',
   'shift-key.js', 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js',
   'contacts-core.js', 'reqs-core.js', 'pto-tracker-core.js', 'suite.js'].forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
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
  /* An account with no stored record has no role, so it has no permissions --
     not even to look. The page it gets says which account it is and what to ask
     for, rather than an empty Settings tab. */
  console.log('— signed in, but the account carries no role —');
  {
    const h = harness();
    await new Promise(r => setTimeout(r, 60));
    seed(h);
    await new Promise(r => setTimeout(r, 40));
    h.w.__setAuth({ ready: true, signedIn: true, email: 'cody@geodis.com', account: null });
    await new Promise(r => setTimeout(r, 30));
    const r = await openAndPick(h);
    t('there is no connection list to reach', !r.review);
    t('the gate is up instead', !!h.$('.gate-card'));
    t('naming the account', h.d.body.textContent.indexOf('cody@geodis.com') !== -1);
    t('and saying who can fix it', /manager or an administrator/i.test(h.d.body.textContent));
    t('nothing was saved', h.links().length === 0);
    t('and no name prompt was shown', h.prompts.length === 0);
  }

  console.log('— signed out —');
  {
    const h = harness();
    await new Promise(r => setTimeout(r, 60));
    seed(h);
    await new Promise(r => setTimeout(r, 40));
    h.w.__setAuth({ ready: true, signedIn: false, email: '', account: null });
    await new Promise(r => setTimeout(r, 30));
    h.w.GEODISSuite.go('settings');
    await new Promise(r => setTimeout(r, 40));
    t('a sign-in card, not the suite', !!h.$('[data-signin]'));
    t('no navigation to anywhere else', h.$$('.suite-nav-btn').length === 0);
    t('and none of the roster on screen',
      h.d.body.textContent.indexOf('Someone Else Entirely') === -1);
  }

  console.log('— a read-only account —');
  {
    const h = harness();
    await new Promise(r => setTimeout(r, 60));
    seed(h);
    await new Promise(r => setTimeout(r, 40));
    h.w.__setRole('viewer');
    await new Promise(r => setTimeout(r, 30));
    const r = await openAndPick(h);
    t('Connections is not offered at all', !r.review);
    t('but the page is', !h.$('.gate-card') && !!h.$('.suite-nav-btn'));
    t('and nothing was written', h.links().length === 0);
  }

  console.log('— a saved connection leaves the list —');
  {
    const h = harness();
    await new Promise(r => setTimeout(r, 60));
    seed(h);
    await new Promise(r => setTimeout(r, 40));
    h.w.__setAuth({ ready: true, signedIn: true, email: 'cody@geodis.com',
      account: { email: 'cody@geodis.com', name: 'Cody Hale', role: 'admin', enabled: true, markets: [] } });
    await new Promise(r => setTimeout(r, 30));
    h.w.GEODISSuite.go('settings');
    await new Promise(r => setTimeout(r, 40));
    t('the person is listed to start with', h.$$('.connect-pending tbody tr').length === 1);
    await openAndPick(h);
    t('the connection is saved', h.links().length === 1);
    t('the timeclock id reaches the profile', h.w.GEODISSuite.profile('B2').timeclockId === '80-ZZOTHER111');
    // Without a rebuild the profile keeps its old id and the row stays put, which
    // is indistinguishable from the save having failed.
    t('and the row is gone from the unconnected list', h.$$('.connect-pending tbody tr').length === 0);
    t('and appears on the connected list, where it can be undone',
      h.$$('.connect-made tbody tr').length === 1 && !!h.$('[data-disconnect]'));
    t('the modal is closed', !h.$('#suite-modal'));
    t('no alert, because nothing went wrong', h.alerts.length === 0);
  }

  console.log('— undoing a connection —');
  {
    /* A connection is a decision, and decisions are sometimes wrong: the workbook
       can carry another person's timeclock id. Two links on one badge here, as
       Naseer really has -- his own, and Edwin Pasquel's off the workbook row. */
    const seeded = [
      { id: 'TCL-80-WRONG0001', eid: '80-WRONG0001', badge: 'B2', rosterName: 'Someone Else Entirely', name: 'Zzz', linkedBy: 'Cody', linkedAt: '2026-08-31T00:00:00Z' },
      { id: 'TCL-80-RIGHT0002', eid: '80-RIGHT0002', badge: 'B2', rosterName: 'Someone Else Entirely', name: 'Zzz', linkedBy: 'Cody', linkedAt: '2026-08-27T00:00:00Z' }
    ];
    const h = harness({ links: seeded });
    await new Promise(r => setTimeout(r, 60));
    const st = h.w.GEODISSuite.state;
    st.storesLoaded = true;
    st.stores.shifts = [{ eid: '80-WRONG0001', name: 'Zzz, Totally Different', nameKey: 'totally different zzz', shift: '2nd', building: '1536' }];
    st.stores.timeclockLinks = seeded.slice();
    h.d.dispatchEvent(new h.w.CustomEvent('geodis:records', { detail: { records: [
      { badge: 'B2', person: 'Someone Else Entirely', empNumber: 'E2', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' }
    ] } }));
    await new Promise(r => setTimeout(r, 40));
    h.w.__setAuth({ signedIn: true, email: 'cody@geodis.com', account: { email: 'cody@geodis.com', name: 'Cody', role: 'admin', enabled: true, markets: [] } });
    st.admin.tab = 'connections'; st.admin.loaded = true;
    h.w.GEODISSuite.go('settings');
    await new Promise(r => setTimeout(r, 40));

    t('both connections are listed', h.$$('.connect-made tbody tr').length === 2);
    t('each can be undone', h.$$('.connect-made [data-disconnect]').length === 2);
    t('two ids on one person are flagged', h.$$('.warn-banner').some(b => /more than one timeclock id/.test(b.textContent)));
    // A stored link makes the row count as connected, so it is NOT on the list above.
    t('and the workbook row counts as connected', h.$$('.connect-pending tbody tr').length === 0);

    h.click(h.$('[data-disconnect="TCL-80-WRONG0001"]'));
    await new Promise(r => setTimeout(r, 150));
    t('removing one leaves the other', st.stores.timeclockLinks.length === 1 &&
      st.stores.timeclockLinks[0].eid === '80-RIGHT0002');
    t('the profile falls back to the id that remains',
      h.w.GEODISSuite.profile('B2').timeclockId === '80-RIGHT0002');
    /* The workbook still carries the wrong id, so the person returns to the
       unconnected list. That is the point: the tool keeps asking until the source
       is fixed, rather than remembering a decision that papers over a data error. */
    t('the workbook row goes back to unconnected', h.$$('.connect-pending tbody tr').length === 1);
    t('and one id left means no conflict to flag',
      !h.$$('.warn-banner').some(b => /more than one timeclock id/.test(b.textContent)));
  }

  console.log('— disconnecting asks first —');
  {
    const one = [{ id: 'TCL-X', eid: '80-X', badge: 'B2', rosterName: 'Someone Else Entirely', linkedBy: 'Cody', linkedAt: '2026-08-31T00:00:00Z' }];
    const h = harness({ links: one });
    await new Promise(r => setTimeout(r, 60));
    const st = h.w.GEODISSuite.state;
    st.storesLoaded = true;
    st.stores.shifts = [];
    st.stores.timeclockLinks = one.slice();
    h.d.dispatchEvent(new h.w.CustomEvent('geodis:records', { detail: { records: [
      { badge: 'B2', person: 'Someone Else Entirely', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' }
    ] } }));
    await new Promise(r => setTimeout(r, 40));
    st.admin.tab = 'connections'; st.admin.loaded = true;
    h.w.GEODISSuite.go('settings');
    await new Promise(r => setTimeout(r, 40));
    let asked = null;
    h.w.confirm = m => { asked = m; return false; };          // the person says no
    h.click(h.$('[data-disconnect="TCL-X"]'));
    await new Promise(r => setTimeout(r, 80));
    t('it asks before removing anything', !!asked);
    t('naming who and which id', /80-X/.test(asked) && /Someone Else Entirely/.test(asked));
    t('and warning that the workbook is unchanged', /workbook/i.test(asked));
    t('saying no removes nothing', st.stores.timeclockLinks.length === 1);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
