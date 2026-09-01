/* GEODIS Management Suite -- shell and modules.
 *
 * The roster is not stored here. It is derived from the RC / Beeline assignment
 * snapshot that the reconciliation view loads each morning (see suite-data.js),
 * so there is exactly one list of people in the product. Attendance, time off,
 * performance, and requisitions are shared server collections, keyed by badge.
 */
(function () {
  'use strict';

  var MAX_ROWS = 250;   // cap rendered rows; the roster runs to the hundreds

  /* GEODIS policy: PTO is 0, an absence is 1, a no-call/no-show is 2, and a late
     or early-out is half an absence.

     Attendance is not typed into this tool. It is logged on the PLX workbook and
     read back from it, so this scale exists to READ that sheet by -- never to
     score an occurrence the tool invented. attendance-import.js MUST agree with
     it: the same occurrence cannot be worth more because of how it arrived. */
  var TYPE_POINTS = {
    'Present': 0, 'Late': 0.5, 'Early Out': 0.5, 'Absent': 1,
    'No Call / No Show': 2, 'Excused': 0
  };
  /* The attendance tab of the PLX workbook -- where occurrences are actually
     logged. An occurrence typed into this tool would never reach that sheet, and
     a point balance that exists in only one of the two is worse than none, so
     the tool reads attendance and links out to it rather than offering to add. */
  var PLX_ATTENDANCE_URL = 'https://geodis.sharepoint.com/:x:/r/sites/chicago-campus-operations/' +
    '_layouts/15/Doc.aspx?sourcedoc=%7B22D6D56E-60DC-4966-8143-0DA8DEF03515%7D' +
    '&file=PLX%20-%20Geodis%20Spreadsheet.xlsx&action=default&mobileredirect=true';
  var TIME_OFF_TYPES = ['PTO', 'VTO', 'Sick', 'Personal', 'LOA'];
  /* How a documented absence is characterised. "Badge / system issue" matters
     most: it is the way to record that the person WAS here and the reader missed
     them, so a hardware gap never turns into a disciplinary record. */
  var DISPOSITIONS = ['', ScheduleCore.PRESENT_DISPOSITION, 'Called in', 'No call / no show',
    'Approved time off', 'Late arrival', 'Left early', 'Reassigned', 'Terminated',
    'Badge / system issue', 'Other'];
  /* Disposition -> what the workbook should end up carrying for that day. It is
     shown, never written: whoever documents the floor here still logs the
     occurrence on the sheet, and knowing what the day is worth before they get
     there is the whole point. null means the absence is explained and costs
     nothing, so there is nothing to carry over. */
  var DISPOSITION_OCCURRENCE = {
    // They were here -- the reader saw a punch out, or missed the punch in.
    'Present': null,
    'Called in': { type: 'Absent', points: TYPE_POINTS['Absent'] },
    'No call / no show': { type: 'No Call / No Show', points: TYPE_POINTS['No Call / No Show'] },
    'Approved time off': null,
    'Late arrival': { type: 'Late', points: TYPE_POINTS['Late'] },
    'Left early': { type: 'Early Out', points: TYPE_POINTS['Early Out'] },
    'Reassigned': null,
    // Gone. Nobody accrues attendance points after they leave, and the empty
    // shift is a staffing problem rather than a disciplinary one.
    'Terminated': null,
    'Badge / system issue': null,
    // Something happened, but not something the policy scale scores.
    'Other': { type: 'Absent', points: 0 }
  };
  var NAV = [
    ['overview', 'Overview'], ['tasks', 'Tasks'], ['associates', 'Associates'],
    ['coverage', 'On-Premise'], ['attendance', 'Attendance'], ['timeoff', 'Time Off'],
    ['payroll', 'Payroll'], ['requisitions', 'Beeline Requests'],
    ['reconciliation', 'Assignment Reconciliation'], ['settings', 'Settings']
  ];

  var state = {
    view: new URLSearchParams(location.search).get('view') || 'overview',
    profileBadge: null,
    query: '',
    sort: { associates: { key: 'name', dir: 1 }, attendance: { key: 'date', dir: -1 },
      // Most short-handed first: the order somebody actually works the list in.
      requisitions: { key: 'short', dir: -1 } },
    market: (function () {
      try { return localStorage.getItem('badgeCrosscheck.market') || 'all'; } catch (e) { return 'all'; }
    })(),
    /* Everyone, not just the active. An ended associate still needs notes and
       payroll issues logged against them, and a listing that hides them makes
       that look impossible. The filter is still there for narrowing down. */
    statusFilter: 'all',
    records: null,          // null = snapshot has not arrived yet
    notes: {},              // shared badge -> note, published with the roster
    updatedAt: null,
    profiles: new Map(),
    tasks: { kind: 'all', showDone: false },
    stores: { attendance: [], timeOff: [], requisitions: [], reqCandidates: [], performance: [], shifts: [], discrepancies: [], tasks: [], contacts: [],
      associatePto: [], locations: [], appConfig: [], timeclockLinks: [] },
    reqSources: [],          // export files loaded this session, merged before saving
    reqImport: null,         // last import result, for the report shown after
    ptoImport: null,         // the shared IL PTO tracker's last import
    reqExpanded: {},         // request id -> candidate list open
    reqHealth: 'all',
    reqSite: 'all',          // work-location number, within the chosen market
    reqWhen: 'all',          // start-date window
    connectFor: '', connectQuery: '', connectKind: 'timeoff',
    payroll: { periods: [], week: '', period: null, tab: 'discrepancies', loading: false },
    plx: { sync: null, busy: false, note: '' },   // the last PLX workbook uploaded
    ilPto: { sync: null },                        // what the PTO tracker flow last did
    auth: { signedIn: false, email: '', account: null, loading: false, error: '' },
    admin: { users: [], locations: [], shiftTypes: [], appConfig: [], loaded: false, tab: 'account' },
    shiftKey: null,          // parsed "Geodis Key" vocabulary, when a workbook is loaded
    shiftImport: null,       // last import result, for the report shown after
    storesLoaded: false,
    // Coverage inputs are uploaded reports, not shared collections: the schedule
    // lands weekly, the on-premise snapshot several times a day.
    coverage: {
      presence: null, presenceFile: '',
      asOf: null, grace: ScheduleCore.GRACE_MINUTES,
      statusFilter: 'exceptions', location: 'all',
      // Spreadsheet export: which branch block is being rebuilt.
      exportOpen: false, exportShift: '1st', exportLoc: 'all',
      // Loaded back from Firebase: this week's stored plan and today's stored
      // checks. These are what make a schedule and an absence outlive the tab.
      storedWeek: null, storedDay: null, saving: '', savedAt: '',
      // Reviewing a check someone already uploaded, rather than the live compare.
      dates: [], reviewDate: '', reviewId: '', reviewDay: null
    }
  };

  /* The reconciliation view has had its own market filter since before the suite
     existed, persisted under this key. Both pickers now drive the same value, so
     choosing a market in the header scopes the reconciliation table too, and the
     choice survives a reload. */
  var MARKET_KEY = 'badgeCrosscheck.market';
  function setMarket(m, fromRecon) {
    if (state.market === m) return;
    state.market = m;
    // A site belongs to a market, so a site chosen in the previous one would filter
    // the new market to nothing and read as an empty tab.
    state.reqSite = 'all';
    try { localStorage.setItem(MARKET_KEY, m); } catch (e) { /* private mode */ }
    if (!fromRecon) {
      document.dispatchEvent(new CustomEvent('geodis:market', { detail: { market: m, source: 'suite' } }));
    }
    render();
  }
  document.addEventListener('geodis:market', function (e) {
    if (!e.detail || e.detail.source === 'suite') return;
    setMarket(e.detail.market, true);
  });

  /* Until there is sign-in, the person making a change is a name they type once
     into this browser. Every status change records it, so when real identity
     arrives only this function changes -- the stored shape and every reader of
     it stay put. See timeoff-core.js. */
  var ACTOR_KEY = 'geodis.actorName';
  function currentActor(promptIfMissing) {
    /* Once somebody is signed in, that IS the actor. This is the single place
       the switch happens, which is why the change log was built to carry an id
       and a source from the start. */
    /* Being signed in is enough. The account RECORD may not have loaded -- it
       comes from the admin users list, which only an administrator can read -- and
       falling through to the browser prompt because of that asked a signed-in
       person to type the name they had just signed in with, and silently did
       nothing when they dismissed it. */
    if (state.auth.signedIn && (state.auth.account || state.auth.email)) {
      var acct = state.auth.account || {};
      var who = acct.name || acct.email || state.auth.email;
      return PipelineCore.actorOf(who, acct.email || state.auth.email, 'account');
    }
    var name = '';
    try { name = localStorage.getItem(ACTOR_KEY) || ''; } catch (e) { /* private mode */ }
    if (!name && promptIfMissing) {
      name = (window.prompt('Your name, so status changes can be attributed.\n\n' +
        'This is stored in this browser only, until sign-in is added.', '') || '').trim();
      /* Every caller of currentActor(true) is about to write something and cannot
         without a name. Returning null quietly meant the click just did nothing --
         no save, no message, nothing to tell you the difference between "it failed"
         and "it worked but the list has not caught up". Say it out loud instead;
         a browser that has been told to suppress dialogs will not show the prompt
         at all, and this is the only sign you would get. */
      if (!name) {
        alert('That was not saved, because it records who made the change and no name was given.\n\n' +
          'Sign in under Settings, or answer the name prompt, and try again.');
        return null;
      }
      try { localStorage.setItem(ACTOR_KEY, name); } catch (e) { /* ignore */ }
    }
    var id = '';
    try { id = localStorage.getItem('geodisSuite.localUserId') || ''; } catch (e) { /* ignore */ }
    return TimeOffCore.actorOf(name, id, 'local');
  }

  var root = document.getElementById('suite-root');
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var today = function () {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };
  var daysBack = function (n) {
    var d = new Date(); d.setDate(d.getDate() - n);
    var p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };

  /* ---------- identifying an associate ----------
     Three numbers follow these people around and they are not interchangeable:

       EID          the Legacy Contact ID in RC. 7-8 digits. This is what the
                    team searches by, so it is what the tool leads with.
       Badge        the Beeline assignment number. 6 digits. It is what records
                    are keyed by internally, because it is the one every report
                    carries -- but it is a Beeline artefact, not how anybody
                    refers to a person.
       Timeclock id the WFM id, "80-JALCAL5986". The PLX workbook heads its
                    column "EID", which is the collision worth knowing about:
                    that column is NOT the RC Legacy Contact ID. It is called
                    the timeclock id everywhere here so the two cannot be
                    confused.

     Every search box matches all three, so whichever number somebody has in
     front of them finds the person. */
  function eidOf(p) { return (p && p.empNumber) || ''; }
  function idLine(p) {
    if (!p) return '';
    return (p.empNumber ? 'EID ' + esc(p.empNumber) : '<span class="warn-text">No EID</span>') +
      (p.badge ? ' · Badge ' + esc(p.badge) : '');
  }
  function searchText(p, extra) {
    if (!p) return String(extra || '');
    return [p.name, p.empNumber, p.badge, p.timeclockId, p.market, extra || ''].join(' ');
  }
  /* Finding somebody from something typed into a box. The EID is tried first,
     because that is what people have to hand; the badge and timeclock id still
     work, so an old habit is not punished. */
  function findByAnyId(v) {
    var q = String(v == null ? '' : v).trim();
    if (!q) return null;
    var lower = q.toLowerCase();
    var all = allProfiles();
    var byEid = all.filter(function (p) { return String(p.empNumber || '') === q; });
    if (byEid.length === 1) return byEid[0];
    var direct = profile(SuiteData.normBadge(q));
    if (direct) return direct;
    var byClock = all.filter(function (p) {
      return String(p.timeclockId || '').toLowerCase() === lower;
    });
    if (byClock.length === 1) return byClock[0];
    var byName = all.filter(function (p) { return String(p.name || '').toLowerCase() === lower; });
    return byName.length === 1 ? byName[0] : null;
  }

  /* ---------- data ---------- */
  function rebuild() {
    state.profiles = SuiteData.buildProfiles(state.records || [], {
      attendance: state.stores.attendance,
      timeOff: state.stores.timeOff,
      performance: state.stores.performance,
      shifts: state.stores.shifts,
      locations: state.stores.locations,
      associatePto: state.stores.associatePto,
      shiftKeyOf: ScheduleCore.rosterKey,
      timeclockLinks: state.stores.timeclockLinks,
      phoneOf: (function () {
        var ix = ContactsCore.index(state.stores.contacts, SuiteData.normBadge);
        return function (p) { return ContactsCore.lookup(ix, p, ScheduleCore.rosterKey); };
      })(),
      // Approved time off clears the points for the day it covers.
      ptoCover: function (requests, iso) {
        for (var i = 0; i < (requests || []).length; i++) {
          var r = requests[i];
          if (TimeOffCore.isExcused(r.status) && TimeOffCore.coversDate(r, iso)) return r;
        }
        return null;
      },
      notes: state.notes
    });
    validateMarket();
  }
  function allProfiles() { return Array.from(state.profiles.values()); }
  /* A market persisted from an earlier session can outlive the snapshot that had
     it. Without this the picker reads "All markets" (no option matches, so none
     is selected) while every view silently filters to nothing. */
  function validateMarket() {
    if (state.market === 'all' || !state.profiles.size) return;
    if (markets().indexOf(state.market) === -1) state.market = 'all';
  }
  function profile(badge) { return state.profiles.get(SuiteData.normBadge(badge)) || null; }
  /* Every market the tool holds data for, not only the ones with associates on the
     roster. A Beeline request derives its market from the work-location number, so
     a market can have open requests and nobody placed yet -- and that is exactly
     the market somebody wants to filter to. */
  function markets() {
    var set = new Set();
    allProfiles().forEach(function (p) { if (p.market) set.add(p.market); });
    (state.stores.requisitions || []).forEach(function (r) { if (r.market) set.add(r.market); });
    return Array.from(set).sort();
  }
  /* ---------- market scoping ----------
     The header's market picker scopes the WHOLE tool, so every view reads its
     data through these rather than off state.stores directly. A market of 'all'
     returns everything, so they are safe to call unconditionally. */
  function inMarket(p) { return state.market === 'all' || (!!p && p.market === state.market); }
  function profilesInMarket() { return allProfiles().filter(inMarket); }
  // Records keyed by badge: a row whose badge is not on the roster has no market
  // of its own. Attendance surfaces those separately in its orphan banner.
  function byBadgeInMarket(rows) {
    if (state.market === 'all') return rows;
    return rows.filter(function (r) { return inMarket(profile(r.badge)); });
  }
  // A requisition carries its own market, and one with none is a position that
  // has not been assigned to a branch yet -- it stays visible everywhere.
  function requisitionsInMarket() {
    if (state.market === 'all') return state.stores.requisitions;
    return state.stores.requisitions.filter(function (r) { return !r.market || r.market === state.market; });
  }

  /* ---------- sorting ----------
     Values are compared as strings unless both are numbers, so "1502" sorts
     before "1519" and points sort 2 before 10. Blanks always sink to the bottom
     regardless of direction -- an associate with no site recorded is not the
     "first" site, they are missing one. */
  function blank(v) { return v === '' || v == null; }
  function cmp(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }
  function sortRows(rows, table, valueOf) {
    var st = state.sort[table];
    return rows.slice().sort(function (x, y) {
      var a = valueOf(x, st.key), b = valueOf(y, st.key);
      // A missing value is not the smallest value, so it takes no part in the
      // direction: reversing the sort must not float everyone with no site
      // recorded to the top of the page.
      if (blank(a) !== blank(b)) return blank(a) ? 1 : -1;
      var d = blank(a) ? 0 : cmp(a, b) * st.dir;
      // Ties break by name, always ascending -- a stable, readable second key.
      return d || cmp(valueOf(x, 'name'), valueOf(y, 'name'));
    });
  }
  function sortHead(table, key, label) {
    var st = state.sort[table];
    var on = st.key === key;
    return '<th class="sortable' + (on ? ' sorted' : '') + '" data-sort="' + table + ':' + key + '">' +
      esc(label) + '<span class="sort-arrow">' + (on ? (st.dir === 1 ? '▲' : '▼') : '') + '</span></th>';
  }

  // The roster subset the module tabs operate on: market, status, then search.
  function roster() {
    var q = state.query.trim().toLowerCase();
    return allProfiles().filter(function (p) {
      if (!inMarket(p)) return false;
      if (state.statusFilter !== 'all' && p.status !== state.statusFilter) return false;
      if (!q) return true;
      return searchText(p).toLowerCase().indexOf(q) !== -1;
    });
  }

  /* ---------- shell ---------- */
  function icon(name) {
    return {
      overview: '<path d="M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-7H9v7H4a1 1 0 01-1-1z"/>',
      tasks: '<path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>' +
        '<rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12l2 2 4-4"/>',
      associates: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>',
      coverage: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
      attendance: '<rect x="3" y="5" width="18" height="16" rx="1"/><path d="M8 3v4m8-4v4M3 10h18m-13 5l2 2 5-5"/>',
      timeoff: '<path d="M3 12a9 9 0 0118 0H3zm9 0v9m-4 0h8"/>',
      payroll: '<rect x="3" y="6" width="18" height="12" rx="1"/><circle cx="12" cy="12" r="2.5"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10l2 2M19 5l-2 2M7 17l-2 2"/>',
      requisitions: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7"/>',
      reconciliation: '<rect x="5" y="4" width="14" height="17" rx="1"/><path d="M9 4V2h6v2M8 9h8m-8 4h5m-5 4h7"/>'
    }[name] || '';
  }
  function navHtml() {
    var active = state.view === 'profile' ? 'associates' : state.view;
    return '<aside class="suite-nav"><div class="suite-brand"><div class="suite-logo">G</div>' +
      '<div><strong>GEODIS</strong><small>MANAGEMENT SUITE</small></div></div>' +
      '<nav class="suite-nav-list">' + NAV.map(function (n) {
        return '<button class="suite-nav-btn ' + (active === n[0] ? 'active' : '') + '" data-nav="' + n[0] + '">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">' + icon(n[0]) + '</svg><span>' + n[1] + '</span></button>';
      }).join('') + '</nav><div class="suite-nav-footer">Workforce Management Suite<br>' +
      (state.updatedAt ? 'Roster synced ' + esc(new Date(state.updatedAt).toLocaleString()) : 'Awaiting roster sync') +
      '</div></aside>';
  }
  function headerHtml() {
    var labels = {
      overview: ['Overview', 'Workforce command center'],
      tasks: ['Tasks', 'Work that is outstanding, wherever it was raised'],
      associates: ['Associates', 'Roster, scorecards, and profile detail'],
      profile: ['Associate Profile', 'Assignment, attendance, time off, and performance'],
      coverage: ['On-Premise', 'Scheduled shifts vs. who is actually on premise'],
      attendance: ['Attendance', 'Occurrences and points'],
      timeoff: ['Time Off', 'PTO and VTO tracking'],
      payroll: ['Payroll', 'Hours changes and discrepancy tracking'],
      settings: ['Settings', 'Accounts, locations and shifts'],
      requisitions: ['Beeline Requests', 'Staffing demand and fulfillment'],
      reconciliation: ['Assignment Reconciliation', 'Beeline ⇆ RC active-assignment crosscheck']
    };
    var x = labels[state.view] || labels.overview;
    var mkts = markets();
    var picker = mkts.length
      ? '<select class="suite-select suite-market" id="market-picker"><option value="all">All markets</option>' +
        mkts.map(function (m) {
          return '<option value="' + esc(m) + '" ' + (state.market === m ? 'selected' : '') + '>' + esc(m) + '</option>';
        }).join('') + '</select>'
      : '';
    /* A task can be raised from anywhere, because that is where they get
       noticed -- on the floor, mid-check, reading a form. The count is what is
       urgent, not what is open: a badge showing 40 is wallpaper. */
    var urgent = TasksCore.summarize(openTasks(), new Date()).urgent;
    var add = '<button class="suite-add" data-add-task title="Raise a task">' +
      '<span class="suite-add-plus">+</span><span class="suite-add-label">Task</span>' +
      (urgent ? '<span class="suite-add-count">' + urgent + '</span>' : '') + '</button>';
    return '<header class="suite-top"><div class="suite-heading"><h1>' + esc(x[0]) + '</h1><p>' + esc(x[1]) + '</p></div>' +
      picker + add + '<div class="suite-user"><span><b>Operations</b></span><div class="suite-avatar">OP</div></div></header>';
  }

  /* ---------- small building blocks ---------- */
  function metric(label, value, note, kind) {
    return '<div class="metric"><div class="metric-icon ' + (kind || '') + '">' +
      (kind === 'green' ? '✓' : kind === 'orange' ? '!' : '#') + '</div><div>' +
      '<div class="metric-label">' + esc(label) + '</div><div class="metric-value">' + esc(value) + '</div>' +
      '<div class="metric-note">' + esc(note) + '</div></div></div>';
  }
  function empty(label, sub) {
    return '<div class="empty-module"><strong>' + esc(label) + '</strong>' + esc(sub || 'Import a report or add a record to begin tracking.') + '</div>';
  }
  function hero(title, sub, action, label) {
    return '<div class="module-hero"><div><h2>' + esc(title) + '</h2><p>' + esc(sub) + '</p></div>' +
      (action ? '<button class="suite-btn primary" data-add="' + action + '">+ ' + esc(label) + '</button>' : '') + '</div>';
  }
  // The same hero for a page that only reads: its action opens the sheet that
  // owns the data, in a new tab, instead of a form that writes here.
  function heroLink(title, sub, href, label) {
    return '<div class="module-hero"><div><h2>' + esc(title) + '</h2><p>' + esc(sub) + '</p></div>' +
      extLink(href, label, 'suite-btn primary') + '</div>';
  }
  function extLink(href, label, cls) {
    return '<a class="' + cls + '" href="' + esc(href) + '" target="_blank" rel="noopener">' +
      esc(label) + '<span class="ext-mark" aria-hidden="true">\u2197</span></a>';
  }
  function filters(placeholder) {
    return '<div class="filter-row"><input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="' + esc(placeholder || 'Search by name, badge, or employee #…') + '">' +
      '<select class="suite-select" id="status-filter">' +
      ['all', 'Active', 'Ended'].map(function (v) {
        return '<option value="' + v + '" ' + (state.statusFilter === v ? 'selected' : '') + '>' +
          (v === 'all' ? 'Active and ended' : v) + '</option>';
      }).join('') + '</select></div>';
  }
  /* A shift tag is what the person works, not what they were scheduled for this
     week. It comes from the PLX workbook and is editable per associate. */
  function shiftChip(p) {
    if (!p.shift) return '<span class="shift-chip none" data-set-shift="' + esc(p.badge) + '">Set shift</span>';
    return '<span class="shift-chip" data-set-shift="' + esc(p.badge) + '"' +
      (p.shiftHours ? ' title="' + esc(p.shiftHours) + (p.shiftBuilding ? ' · building ' + esc(p.shiftBuilding) : '') + '"' : '') +
      '>' + esc(p.shift) + '</span>';
  }

  function shiftImportPanel(total, tagged) {
    var imp = state.shiftImport;
    return '<section class="suite-panel shift-import"><div class="suite-panel-head">' +
      '<h2>Shift tags</h2><div class="suite-actions">' +
      '<label class="suite-btn cov-pick' + (tagged ? '' : ' primary') + '">Import PLX workbook' +
      '<input type="file" accept=".xlsx,.xls" data-shift-book></label></div></div>' +
      '<p class="perf-note"><b>' + tagged + '</b> of ' + total + ' associates in this view carry a shift tag. ' +
      'The weekly WFM schedule only covers people rostered that week, so a tag is what puts everyone else in the ' +
      'right headcount block. Import the workbook once, then set the shift on new associates as they start.</p>' +
      (imp ? shiftImportReport(imp) : '') + '</section>';
  }
  function shiftImportReport(imp) {
    return '<div class="import-report' + (imp.failed ? ' bad' : '') + '">' +
      '<strong>' + esc(imp.headline) + '</strong>' +
      (imp.warnings && imp.warnings.length
        ? '<ul>' + imp.warnings.slice(0, 8).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') +
          (imp.warnings.length > 8 ? '<li>…and ' + (imp.warnings.length - 8) + ' more.</li>' : '') + '</ul>'
        : '') + '</div>';
  }

  /* Reads the whole workbook: the "Geodis Key" tab for the shift vocabulary and
     every "<site> - HC" tab for the per-associate assignment. */
  function readShiftWorkbook(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(e.target.result, { type: 'array' });
        var sheets = wb.SheetNames.map(function (n) {
          return { name: n, aoa: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }) };
        });
        var keySheet = sheets.filter(function (x) { return ShiftKey.KEY_SHEET.test(x.name); })[0];
        var key = keySheet ? ShiftKey.parseShiftKey(keySheet.aoa) : null;
        var hc = ShiftKey.parseHeadcount(sheets, ScheduleCore.rosterKey);
        if (!hc.people.length) {
          throw new Error('No "<site> - HC" tabs with an "Employee  Name" column were found.');
        }
        var records = ShiftKey.toShiftRecords(hc, key);
        var warnings = (key ? key.warnings : ['No "Geodis Key" tab was found, so shift hours are unknown.'])
          .concat(hc.warnings)
          .concat(ShiftKey.validateAgainstKey(hc, key));

        state.shiftKey = key;
        state.shiftImport = { headline: 'Reading ' + records.length + ' shift tags…', warnings: [] };
        render();

        SuiteData.replaceCollection('shifts', records).then(function () {
          state.stores.shifts = records;
          rebuild();
          var matched = allProfiles().filter(function (p) { return !!p.shift; }).length;
          state.shiftImport = {
            headline: records.length + ' shift tags imported from ' + hc.sheets.length + ' site tabs · ' +
              matched + ' matched a roster profile by name',
            warnings: warnings
          };
          render();
        }).catch(function (err) {
          state.shiftImport = { failed: true, headline: 'Could not save the shift tags: ' + err.message, warnings: [] };
          render();
        });
      } catch (err) {
        console.error(err);
        state.shiftImport = { failed: true, headline: 'Could not read "' + file.name + '": ' + err.message, warnings: [] };
        render();
      }
    };
    reader.onerror = function () { alert('Failed to read "' + file.name + '".'); };
    reader.readAsArrayBuffer(file);
  }

  // Setting or correcting one person's shift, for new starters and fixes.
  function setShift(badge) {
    var p = profile(badge);
    if (!p) return;
    var known = {};
    state.stores.shifts.forEach(function (r) { if (r.shift) known[r.shift] = true; });
    if (state.shiftKey) {
      Object.keys(state.shiftKey.byBuilding).forEach(function (b) {
        state.shiftKey.byBuilding[b].forEach(function (sh) { known[sh] = true; });
      });
    }
    var list = Object.keys(known).sort();
    var next = prompt('Shift for ' + p.name +
      (list.length ? '\n\nKnown shifts: ' + list.join(', ') : '') +
      '\n\nLeave blank to clear.', p.shift || '');
    if (next === null) return;
    next = next.trim();
    var id = 'name:' + ScheduleCore.rosterKey(p.name);
    var rec = {
      id: id, eid: '', nameKey: ScheduleCore.rosterKey(p.name), name: p.name,
      shift: next, building: p.shiftBuilding || '', badge: p.badge, source: 'Set in the suite'
    };
    var write = next ? SuiteData.saveRecord('shifts', rec) : SuiteData.deleteRecord('shifts', id);
    write.then(function () {
      return SuiteData.loadCollection('shifts');
    }).then(function (rows) {
      state.stores.shifts = rows;
      rebuild();
      render();
    }).catch(function (err) {
      alert('That shift could not be saved.\n\n' + err.message);
    });
  }

  /* ---------- links into RC ----------
     RC is Salesforce, so a record id becomes a link only once we know the org's
     domain. That is a setting rather than a constant: it differs per org, and
     hard-coding it would mean a code change to fix a URL. With no base URL set,
     nothing renders a broken link -- the id is simply not shown as one. */
  /* Salesforce answers to two host names and people have both to hand: the API
     host (employbridge.my.salesforce.com) and the Lightning host
     (employbridge.lightning.force.com). Record pages live on the Lightning one,
     so an API host is translated rather than refused -- whichever somebody
     pastes, the link opens the record instead of bouncing through a redirect. */
  function rcBase() {
    var row = (state.stores.appConfig || []).filter(function (c) { return c.key === 'rcBaseUrl'; })[0];
    var v = row && row.value ? String(row.value).trim() : '';
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    v = v.replace(/\/+$/, '');
    return v.replace(/^(https:\/\/[^.\/]+)\.my\.salesforce\.com$/i, '$1.lightning.force.com');
  }
  function rcLink(id, object, label, cls) {
    var base = rcBase();
    if (!base || !id) return '';
    return '<a class="rc-link ' + (cls || '') + '" target="_blank" rel="noopener" href="' +
      esc(base + '/lightning/r/' + object + '/' + id + '/view') + '">' + esc(label) + ' ↗</a>';
  }
  function rcContactLink(p, label) { return rcLink(p.contactId, 'Contact', label || 'RC profile'); }
  function rcAssignmentLink(p, label) {
    // The object name for an assignment is org-specific, so it is configurable
    // alongside the base URL rather than assumed.
    var row = (state.stores.appConfig || []).filter(function (c) { return c.key === 'rcAssignmentObject'; })[0];
    return rcLink(p.assignmentId, (row && row.value) || 'TR1__Closing_Report__c', label || 'RC assignment');
  }

  /* "Former" rather than "Ended" for somebody the reconciliation has dropped
     entirely: their assignment did not just end, the roster no longer carries
     them at all, and anything still attached to them is history somebody chose
     to keep. */
  function statusChip(p) {
    if (p.former) {
      return '<span class="status closed" title="No longer in the RC / Beeline reconciliation. ' +
        'Their records are kept and can still be added to.">Former</span>';
    }
    return '<span class="status ' + (p.status === 'Ended' ? 'closed' : '') + '">' + esc(p.status) + '</span>';
  }
  // Reconciliation state shown inline on a profile, so paperwork drift is
  // visible wherever the person is, not only in the reconciliation tab.
  function reconChip(p) {
    if (p.reconciled) return '<span class="recon-chip ok">In sync</span>';
    if (!p.actionLabel) return '<span class="recon-chip">—</span>';
    return '<span class="recon-chip warn" title="' + esc(p.actionReason) + '">' + esc(p.actionLabel) +
      (p.overridden ? ' · manual' : '') + '</span>';
  }
  function scoreCell(p) {
    if (p.score == null) return '<span class="score none">Not scored</span>';
    return '<span class="score ' + (p.score < 80 ? 'bad' : p.score < 90 ? 'warn' : '') + '">' + p.score + '</span>';
  }
  function rowCap(rows, total) {
    if (total <= MAX_ROWS) return '';
    return '<div class="row-cap">Showing ' + rows + ' of ' + total + ' — narrow the search or market to see the rest.</div>';
  }
  function loadingPanel(what) {
    return '<section class="suite-panel"><div class="workflow-empty">Loading ' + esc(what) + '…</div></section>';
  }
  function needsRoster() {
    return '<section class="suite-panel"><div class="workflow-empty">' +
      'Waiting on the morning assignment snapshot. The roster, and every profile built from it, appears once it loads. ' +
      '<button class="suite-btn" data-nav="reconciliation">Open reconciliation</button></div></section>';
  }

  /* ---------- overview ---------- */
  function overview() {
    if (!state.records) return needsRoster();
    // Everything below is scoped to the selected market -- see profilesInMarket().
    var all = profilesInMarket();
    var timeOff = byBadgeInMarket(state.stores.timeOff);
    /* Beeline requests come off the board, not the raw records. The import
       writes beelineOpenings/hired, namespaced away from the openings/filled the
       PLX workbook sync owns, so reading the records directly saw only the
       handful of requests the workbook also lists and understated the shortfall
       by hundreds of seats. */
    var reqBoardAll = reqBoard();
    var reqRows = reqBoardInMarket(reqBoardAll);
    var reqSummary = summarizeVisible(reqRows);
    var otherReqRows = otherReqs(reqBoardAll, 'workbook').concat(otherReqs(reqBoardAll, 'manual'));
    var active = all.filter(function (p) { return p.status === 'Active'; });
    var exceptions = all.filter(function (p) { return !p.reconciled; }).length;
    var pending = timeOff.filter(function (t) { return TimeOffCore.needsAction(t.status); }).length;
    /* Seats still to fill, from EVERY source. A request the PLX workbook has and
       Beeline does not is still a position somebody has to fill, so leaving it out
       of the queue would repeat the bug this figure was just fixed for. */
    var otherShort = otherReqRows.filter(function (r) { return r.status !== 'Filled'; })
      .reduce(function (n, r) {
        return n + Math.max(0, Number(r.openings || 0) - Number(r.filled || 0));
      }, 0);
    var open = (reqSummary.shortBy == null ? 0 : reqSummary.shortBy) + otherShort;
    var atRisk = all.filter(function (p) { return p.points >= 5; }).length;

    /* "Upcoming" has to mean upcoming, not "most recent". A request is upcoming
       while it has not finished -- so today's time off still counts, and
       yesterday's stops cluttering the page. Soonest first, unlike the Time Off
       tab, which is a log and reads newest first. */
    var todayIso = today();
    var upcoming = timeOff.filter(function (x) {
      return String(x.end || x.start || '') >= todayIso;
    }).sort(function (a, b) {
      return String(a.start || '').localeCompare(String(b.start || ''));
    });

    var t = trend();
    var stale = staleNote(state.updatedAt, 'The RC / Beeline roster') +
      staleNote(state.plx.sync && state.plx.sync.syncedAt, 'The PLX workbook');
    return stale + '<div class="metric-strip">' +
      metric('Active associates', active.length, all.length + ' on the assignment roster') +
      metric('Attendance rate', t.latest == null ? '—' : t.latest + '%', t.latest == null ? 'No attendance data yet' : t.latestNote, 'green') +
      metric('PTO / VTO pending', pending, 'Requests needing review') +
      metric('Reconciliation exceptions', exceptions, 'Profiles out of sync', 'orange') +
      '</div><div class="suite-grid"><div class="suite-stack">' +
      '<section class="suite-panel"><div class="suite-panel-head"><h2>Attendance rate trend</h2>' +
      '<div class="suite-actions"><button class="suite-btn" data-nav="attendance">View report</button></div></div>' +
      t.html + '</section>' +
      '<section class="suite-panel"><div class="suite-panel-head"><h2>Beeline requests &amp; coverage</h2>' +
      '<div class="suite-actions"><button class="suite-btn" data-nav="requisitions">View requests</button></div></div>' +
      (reqRows.length
        ? overviewReqNote(reqSummary, otherReqRows, otherShort) + overviewReqTable(reqRows.slice(0, 5))
        : otherReqRows.length ? reqTable(otherReqRows.slice(0, 5), true)
        : empty('No Beeline requests yet')) +
      '</section></div><div class="suite-stack">' +
      '<section class="suite-panel"><div class="suite-panel-head"><h2>Upcoming PTO</h2>' +
      '<div class="suite-actions"><button class="suite-btn" data-nav="timeoff">View all</button></div></div>' +
      (upcoming.length ? upcoming.slice(0, 6).map(activityRow).join('')
        : empty('No upcoming PTO', 'Requests ending today or later appear here.')) +
      '</section><section class="suite-panel"><div class="suite-panel-head"><h2>Operational action queue</h2></div>' +
      alertRow(exceptions, 'Assignment reconciliation exceptions', 'reconciliation') +
      alertRow(pending, 'Pending time-off approvals', 'timeoff') +
      alertRow(open, 'Unfilled Beeline request positions', 'requisitions') +
      alertRow(atRisk, 'Associates at 5+ attendance points', 'attendance') +
      '</section></div></div>';
  }

  /* The dashboard's request panel. Deliberately not the full table: five rows,
     the columns somebody scanning a dashboard acts on, and no expansion. */
  function overviewReqNote(s, others, otherShort) {
    var bits = ['<b>' + s.reqs + '</b> open request' + (s.reqs === 1 ? '' : 's')];
    if (s.requested != null) {
      bits.push('<b>' + (s.hiredAgainstRequested || 0) + '</b> of <b>' + s.requested + '</b> seats filled');
      if (s.shortBy) bits.push('<b class="warn-text">' + s.shortBy + '</b> short');
    }
    if (s.reqsWithOpenings < s.reqs) {
      // Otherwise "12 of 40 seats filled" reads as if it covered all of them.
      bits.push('<span class="sub">openings known for ' + s.reqsWithOpenings + ' of ' + s.reqs + '</span>');
    }
    /* Requests only the workbook or a person knows about are counted apart rather
       than folded in: their seats are real, but their figures come from a
       different place and averaging the two would say neither clearly. */
    if ((others || []).length) {
      bits.push('<span class="sub">plus <b>' + others.length + '</b> not in Beeline' +
        (otherShort ? ', <b class="warn-text">' + otherShort + '</b> short' : '') + '</span>');
    }
    return '<div class="overview-req-note">' + bits.join(' · ') + '</div>';
  }
  function overviewReqTable(rows) {
    return '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
      '<th>Request</th><th>Market</th><th>Submitted</th><th>Filled</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td><div class="name">' + esc(r.jobPosition || 'Beeline request') + '</div>' +
          '<div class="sub">' + esc(r.id) + (r.startDate ? ' · starts ' + esc(r.startDate) : '') + '</div></td>' +
          '<td>' + esc(r.market || '—') + '</td>' +
          '<td>' + r.candidateCount + '</td>' +
          '<td>' + (r.fillPct == null
            ? '<span class="score none">—</span>'
            : '<span class="score ' + (r.fillPct < 70 ? 'bad' : r.fillPct < 90 ? 'warn' : '') + '">' +
              r.hired + ' / ' + r.requested + '</span>') +
          (r.shortBy ? '<div class="sub warn-text">' + r.shortBy + ' short</div>' : '') +
          '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* Real 7-day attendance rate, computed from logged occurrences. "Rate" is the
     share of that day's records that were not an absence or no-call. With no
     attendance data the panel says so rather than drawing an invented line. */
  function trend() {
    var days = [], any = false;
    var events = byBadgeInMarket(state.stores.attendance);
    for (var i = 6; i >= 0; i--) {
      var date = daysBack(i);
      var rows = events.filter(function (a) { return a.date === date; });
      if (rows.length) any = true;
      var bad = rows.filter(function (a) { return a.type === 'Absent' || a.type === 'No Call / No Show'; }).length;
      days.push({ date: date, total: rows.length, rate: rows.length ? Math.round((rows.length - bad) / rows.length * 100) : null });
    }
    if (!any) {
      return { latest: null, latestNote: '', html: '<div class="workflow-empty">No attendance has been logged yet. Rates appear here once occurrences are recorded or imported.</div>' };
    }
    var pts = days.map(function (d, i) {
      var y = d.rate == null ? null : 180 - (d.rate - 70) / 30 * 180;   // 70-100% band
      return { x: i * (700 / 6), y: y == null ? null : Math.max(4, Math.min(176, y)), d: d };
    }).filter(function (p) { return p.y != null; });
    var last = days.slice().reverse().find(function (d) { return d.rate != null; });
    return {
      latest: last ? last.rate : null,
      latestNote: last ? last.total + ' records on ' + last.date : '',
      html: '<div class="trend-chart"><div class="goal-line"></div>' +
        '<svg class="trend-svg" viewBox="0 0 700 180" preserveAspectRatio="none">' +
        '<polyline fill="none" stroke="#0b2c5b" stroke-width="3" points="' +
        pts.map(function (p) { return p.x + ',' + p.y; }).join(' ') + '"/><g fill="#0b2c5b">' +
        pts.map(function (p) { return '<circle cx="' + p.x + '" cy="' + p.y + '" r="4"/>'; }).join('') +
        '</g></svg><div class="trend-labels">' +
        days.map(function (d) { return '<span>' + d.date.slice(5) + '</span>'; }).join('') +
        '</div></div><div class="chart-legend">– – Attendance goal: 92% · scale 70–100%</div>'
    };
  }
  function activityRow(t) {
    var p = profile(t.badge);
    return '<div class="activity-row" data-profile="' + esc(t.badge) + '">' +
      '<div class="initial">' + esc(p ? p.initials : SuiteData.initialsOf(t.badge)) + '</div><div>' +
      '<div class="row-title">' + esc(p ? p.name : 'Badge ' + t.badge) + '</div>' +
      '<div class="row-sub">' + esc(t.start || '') + (t.end && t.end !== t.start ? ' → ' + esc(t.end) : '') +
      ' · ' + esc(t.hours || 0) + ' hours · ' + esc(TimeOffCore.statusMeta(t.status).label) + '</div></div>' +
      '<div class="row-type ' + (t.type === 'VTO' ? 'vto' : t.type === 'Sick' ? 'sick' : '') + '">' + esc(t.type) + '</div></div>';
  }
  function alertRow(n, label, nav) {
    return '<div class="alert-row" data-nav="' + nav + '"><div class="alert-num">' + n + '</div>' +
      '<div class="row-title">' + esc(label) + '</div><span>›</span></div>';
  }

  /* ---------- associates ---------- */
  function associates() {
    if (!state.records) return needsRoster();
    var all = sortRows(roster(), 'associates', function (p, k) {
      if (k === 'location') return p.locationLabel;
      if (k === 'points') return Number(p.points) || 0;
      if (k === 'score') return p.score == null ? '' : Number(p.score);
      return p[k] == null ? '' : p[k];
    });
    var rows = all.slice(0, MAX_ROWS);
    var tagged = all.filter(function (p) { return !!p.shift; }).length;
    return hero('Associate roster', 'Built from the RC / Beeline assignment snapshot. Profiles cannot be added by hand — a profile exists because an assignment does.', '', '') +
      shiftImportPanel(all.length, tagged) +
      '<section class="suite-panel">' + filters() +
      '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
      sortHead('associates', 'name', 'Associate') +
      '<th>EID</th>' +
      sortHead('associates', 'location', 'Site / account') +
      sortHead('associates', 'market', 'Market') +
      sortHead('associates', 'shift', 'Shift') +
      sortHead('associates', 'status', 'Status') +
      '<th>Reconciliation</th>' +
      sortHead('associates', 'points', 'Attendance pts') +
      '<th>Standing</th>' + sortHead('associates', 'score', 'Score') +
      '<th></th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (p) {
        return '<tr><td><div class="name">' + esc(p.name || 'Unknown') + '</div>' +
          '<div class="sub">' + esc(p.badge) + (p.dup ? ' · <b class="dup-flag">DUP</b>' : '') + '</div></td>' +
          '<td>' + (p.empNumber ? '<b>' + esc(p.empNumber) + '</b>' : '<span class="warn-text">—</span>') + '</td>' +
          '<td>' + (p.location
            ? '<div class="name">' + esc(p.location) + '</div>' +
              (p.account ? '<div class="sub">' + esc(p.account) + '</div>' : '')
            : '<span class="sub">—</span>') + '</td>' +
          '<td>' + esc(p.market) + (p.marketRaw ? ' <span class="sub">· ' + esc(p.marketRaw) + '</span>' : '') + '</td>' +
          '<td>' + shiftChip(p) + '</td>' +
          '<td>' + statusChip(p) + '</td><td>' + reconChip(p) + '</td>' +
          '<td>' + p.points + '</td><td><span class="standing ' + p.standingCls + '">' + esc(p.standing) + '</span></td>' +
          '<td>' + scoreCell(p) + '</td>' +
          '<td><button class="suite-btn" data-profile="' + esc(p.badge) + '">Open</button></td></tr>';
      }).join('') : '<tr><td colspan="11">' + empty('No associates match', 'Adjust the search, market, or status filter.') + '</td></tr>') +
      '</tbody></table></div>' + rowCap(rows.length, all.length) + '</section>';
  }

  /* ---------- profile ----------
     The combined view: one person, every module's data about them. */
  function profileView() {
    var p = profile(state.profileBadge);
    if (!p) return '<section class="suite-panel"><div class="workflow-empty">That associate is not on the current roster. ' +
      '<button class="suite-btn" data-nav="associates">Back to roster</button></div></section>';
    var m = p.performance;
    return '<div class="profile-head"><div class="profile-avatar">' + esc(p.initials) + '</div>' +
      '<div class="profile-id"><h2>' + esc(p.name || 'Unknown') + '</h2>' +
      '<p>' + idLine(p) +
      ' · ' + esc(p.market) + '</p>' +
      (p.altName ? '<p class="sub">Also on file as “' + esc(p.altName) + '”</p>' : '') + '</div>' +
      '<div class="profile-chips">' + statusChip(p) + reconChip(p) +
      (p.transitionAssociate ? '<span class="status info">Transition associate</span>' : '') +
      rcContactLink(p) + rcAssignmentLink(p) + '</div>' +
      '<button class="suite-btn" data-nav="associates">← Roster</button></div>' +

      '<div class="metric-strip">' +
      metric('Attendance points', p.points, p.standing, p.points >= 5 ? 'orange' : 'green') +
      metric('Performance score', p.score == null ? '—' : p.score, m ? 'Period ' + (m.period || 'current') : 'No performance record') +
      metric('Time-off requests', p.timeOff.length,
        p.timeOff.filter(function (t) { return TimeOffCore.needsAction(t.status); }).length + ' awaiting action') +
      (p.transitionAssociate ? metric('Transition PTO', p.transitionPtoBalance.toFixed(2) + ' hrs',
        'Original imported balance ' + p.transitionPtoInitial.toFixed(2) + ' hrs', p.transitionPtoBalance ? 'green' : 'orange') : '') +
      metric('Assignment', p.status, p.status === 'Ended' && p.endDate ? 'Ended ' + esc(p.endDate) : 'Per RC / Beeline snapshot') +
      '</div>' +

      '<div class="suite-grid"><div class="suite-stack">' +
      '<section class="suite-panel"><div class="suite-panel-head"><h2>Attendance history</h2>' +
      '<div class="suite-actions">' + extLink(PLX_ATTENDANCE_URL, 'Open the workbook', 'suite-btn') + '</div></div>' +
      (p.attendance.length ? '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
        '<th>Date</th><th>Type</th><th>Minutes</th><th>Points</th><th>Notes</th></tr></thead><tbody>' +
        p.attendance.map(function (a) {
          return '<tr><td>' + esc(a.date) + '</td><td>' + esc(a.type) + '</td><td>' + minutesCell(a) + '</td>' +
            '<td>' + ptoPoints(a) + '</td><td class="detail-cell">' + esc(a.notes || '') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : empty('No occurrences logged', 'Occurrences arrive with the PLX workbook.')) + '</section>' +

      '<section class="suite-panel"><div class="suite-panel-head"><h2>Performance</h2></div>' +
      (m ? '<div class="perf-grid">' +
        perfStat('Quality', m.quality) + perfStat('Productivity', m.productivity) + perfStat('Safety', m.safety) +
        perfStat('Units', m.units, true) + perfStat('Hours', m.hours, true) +
        '</div>' + (m.notes ? '<p class="perf-note">' + esc(m.notes) + '</p>' : '')
        : empty('No performance record', 'Performance metrics load from the site scorecard report.')) + '</section>' +

      '</div><div class="suite-stack">' +
      '<section class="suite-panel"><div class="suite-panel-head"><h2>Time off</h2>' +
      '<div class="suite-actions"><button class="suite-btn primary" data-add="timeoff" data-badge="' + esc(p.badge) + '">+ Request</button></div></div>' +
      (p.timeOff.length ? p.timeOff.map(activityRow).join('') : empty('No time-off records')) + '</section>' +

      schedulePanel(p) +
      '<section class="suite-panel"><div class="suite-panel-head"><h2>Assignment &amp; reconciliation</h2></div>' +
      '<dl class="detail-list">' +
      '<dt>EID</dt><dd>' + (p.empNumber ? '<b>' + esc(p.empNumber) + '</b> <span class="sub">Legacy Contact ID in RC</span>'
        : '<span class="warn-text">Not on the RC record</span>') + '</dd>' +
      detail('Beeline badge', p.badge) +
      (p.timeclockId ? detail('Timeclock id', p.timeclockId) : '') +
      '<dt>Mobile</dt><dd>' + phoneCell(p, { edit: true }) + '</dd>' +
      detail('RC start', p.crmStart) + detail('Beeline start', p.beeStart) +
      detail('End date', p.endDate) + detail('End reason', p.endReason) +
      detail('Market', p.market + (p.marketVerified ? '' : ' (inferred)')) +
      detail('Recommended action', p.actionLabel) +
      (p.contactId ? '<dt>RC record</dt><dd>' + rcContactLink(p, 'Associate') +
        ' ' + rcAssignmentLink(p, 'Assignment') + '</dd>' : '') +
      detail('Reason', p.actionReason) +
      (p.newBadge ? detail('Replacement badge', p.newBadge) : '') +
      (p.note ? detail('Shared note', p.note) : '') +
      '</dl></section></div></div>';
  }
  /* The answer to "is this person's schedule saved, and were they here?" --
     their week from the stored plan, and every on-premise check today. */
  function schedulePanel(p) {
    var keys = ScheduleCore.profileKeys(p);
    var week = state.coverage.storedWeek;
    var day = state.coverage.storedDay;
    var mine = week ? ScheduleCore.scheduleFor(week, keys) : null;
    var att = ScheduleCore.resolveAttendance(day, keys);
    var doc = att.documented;

    var body;
    if (!mine && !att.checks) {
      body = empty('No schedule on file',
        week ? 'This associate is not on the stored weekly schedule.'
             : 'Their shift tag above comes from the PLX workbook; upload one in On-Premise.');
    } else {
      var dates = mine ? Object.keys(mine.shifts).sort() : [];
      body = (mine ? '<div class="sched-week">' + dates.map(function (d) {
        var sh = mine.shifts[d];
        var isToday = d === ScheduleCore.isoDate(new Date());
        return '<div class="sched-day' + (isToday ? ' today' : '') + '">' +
          '<span>' + esc(d.slice(5)) + '</span><b>' +
          esc(sh.code || sh.raw || '—') + '</b></div>';
      }).join('') + '</div>' : '') +
      (att.checks ? attendanceState(att)
        : '<p class="perf-note">No on-premise check has covered this associate today.</p>') +
      (doc ? '<div class="sched-doc"><b>' + esc(doc.disposition || 'Documented') + '</b>' +
        (doc.reason ? ' — ' + esc(doc.reason) : '') + '</div>' : '');
    }
    var tag = '<div class="shift-tag-row"><span>Shift tag</span>' + shiftChip(p) +
      (p.shiftHours ? '<b>' + esc(p.shiftHours) + '</b>' : '') +
      (p.shiftBuilding ? '<em>Building ' + esc(p.shiftBuilding) + '</em>' : '') +
      (p.shiftSource ? '<em>' + esc(p.shiftSource) + '</em>' : '') + '</div>';
    return '<section class="suite-panel"><div class="suite-panel-head"><h2>Schedule &amp; presence</h2>' +
      '<div class="suite-actions"><button class="suite-btn" data-nav="coverage">On-Premise</button></div></div>' +
      tag + body + '</section>';
  }

  /* ONE state for the day, however many times the report was pulled, with the
     individual pulls underneath as supporting detail rather than as separate
     attendance records. */
  function attendanceState(att) {
    var cls = att.present ? 'on' : (att.severity || 'off');
    return '<div class="att-state ' + cls + '">' +
      '<b>' + esc(att.label || 'No state') + '</b>' +
      '<span>' +
      (att.overridden ? 'Marked present despite the reader'
        : att.present ? 'First seen ' + esc((att.firstPresent || '').slice(11, 16))
        : 'Across ' + att.checks + ' check' + (att.checks === 1 ? '' : 's')) +
      '</span></div>' +
      (att.evidence.length > 1
        ? '<div class="att-timeline">' + att.evidence.map(function (e) {
            return '<span class="' + (e.present ? 'on' : 'off') + '" title="' +
              esc(e.present ? 'On premise' : (ScheduleCore.STATUS[e.status] ? ScheduleCore.STATUS[e.status].label : 'Not on premise')) +
              '">' + esc((e.asOf || '').slice(11, 16)) + '</span>';
          }).join('') + '</div>'
        : '');
  }

  function perfStat(label, value, plain) {
    var has = value != null && isFinite(Number(value));
    return '<div class="perf-stat"><span>' + esc(label) + '</span><b>' +
      (has ? esc(value) + (plain ? '' : '%') : '—') + '</b></div>';
  }
  function detail(label, value) {
    if (value == null || value === '') return '';
    return '<dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd>';
  }

  /* ---------- coverage ----------
     The workbook is the plan; the on-premise export is the fact. Crossing them
     answers the question a supervisor actually asks at 11am: is the person who is
     supposed to be on the floor here?

     The two move at different speeds -- the workbook lands once a day, the
     on-premise report is re-pulled several times -- so only the CSV has to be
     dropped again on the second and third pass. The workbook's shift tags are
     stored server-side, and the schedule is derived from them for whatever as-of
     is being looked at, so it can never be a week out of date the way an uploaded
     export could. How old the workbook itself is, is reported by staleNote().

     All of the matching lives in schedule-core.js, the same way the Beeline/RC
     crosscheck lives in reconcile-core.js, so an automated import can reuse it
     without going through the DOM.

     What was here, and why it went: a "Weekly schedule" upload of the WFM
     "Employee Schedule - Weekly" export. The workbook says who works which
     shift, so a second upload saying the same thing could only disagree -- and
     did, silently, whenever the stored week was older than the workbook. The
     stored weeks are still readable on a profile; nothing new is written.

     ---------- coverage persistence ----------
     The record of who was scheduled, who was actually here, and why they were
     not lives in Firebase: partitioned by week for the plan and by day for the
     checks. See DATA_MODEL.md. */
  function persistCheck(fileName) {
    var res = buildCoverageResult();
    if (!res) return;   // no schedule loaded yet; the check is saved once there is one
    var date = ScheduleCore.isoDate(coverageAsOf());
    var check = ScheduleCore.toCheck(res, { fileName: fileName });
    state.coverage.saving = 'check';
    render();
    SuiteData.saveCheck(date, check).then(function () {
      return Promise.all([SuiteData.loadCoverage(date), SuiteData.loadCoverageDates()]);
    }).then(function (r) {
      state.coverage.storedDay = r[0];
      // So the pull just saved is immediately reviewable.
      state.coverage.dates = r[1] || state.coverage.dates;
      savedOk();
    }).catch(function (err) { saveFailed('on-premise check', err); });
  }

  function savedOk() {
    state.coverage.saving = '';
    state.coverage.savedAt = new Date().toLocaleTimeString();
    render();
  }
  function saveFailed(what, err) {
    state.coverage.saving = '';
    render();
    console.warn('Could not save the ' + what + '.', err);
    alert('The ' + what + ' could not be saved to Firebase, so it is only in this browser.\n\n' + err.message);
  }

  // Pull back this week's plan and today's checks, so a profile can show a
  // schedule and a presence history without re-uploading anything.
  function loadPayrollIndex() {
    return SuiteData.loadPayrollPeriods().then(function (periods) {
      state.payroll.periods = periods;
      render();
      if (periods.length) return openPayrollWeek(periods[periods.length - 1]);
    });
  }
  function openPayrollWeek(week) {
    state.payroll.week = week;
    if (!week) { state.payroll.period = null; render(); return Promise.resolve(); }
    state.payroll.loading = true;
    render();
    return SuiteData.loadPayrollPeriod(week).then(function (period) {
      state.payroll.period = period;
      state.payroll.loading = false;
      render();
    });
  }

  function loadStoredCoverage() {
    var todayIso = ScheduleCore.isoDate(new Date());
    var week = SuiteData.weekStart(todayIso);
    return Promise.all([SuiteData.loadSchedule(week), SuiteData.loadCoverage(todayIso), SuiteData.loadCoverageDates()])
      .then(function (r) {
        state.coverage.storedWeek = r[0];
        state.coverage.storedDay = r[1];
        state.coverage.dates = r[2] || [];
        render();
      });
  }

  function locLeaf(path) {
    var parts = String(path || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }
  function dtValue(d) {
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function coverageAsOf() { return state.coverage.asOf || new Date(); }

  /* The workbook already says who works which shift and what hours that shift
     runs, so a schedule is derived from it rather than uploaded. An uploaded WFM
     export still wins when there is one -- it knows a specific day's PTO, which
     a standing schedule cannot. */
  /* The workbook is the only schedule. Its shift tags are stored server-side, so
     this works on a fresh browser with nothing but the on-premise export dropped
     in -- the workbook does not have to be re-uploaded to see coverage. */
  function activeSchedule() {
    var tags = state.stores.shifts || [];
    if (!tags.length) return null;
    return ShiftKey.scheduleFromShifts(tags, {
      asOf: coverageAsOf(),
      nameKeyOf: ScheduleCore.nameKey     // the form buildCoverage joins on
    });
  }
  function buildCoverageResult() {
    var c = state.coverage;
    var schedule = activeSchedule();
    if (!schedule || !c.presence) return null;
    var res = ScheduleCore.buildCoverage({
      schedule: schedule, presence: c.presence,
      asOf: coverageAsOf(), graceMinutes: c.grace
    });
    res.scheduleSource = schedule.derived ? 'workbook' : 'upload';
    res.scheduleGaps = schedule.withoutHours || [];
    // Reach from each row to its roster profile so a supervisor can go straight to
    // attendance and time off from an exception.
    ScheduleCore.linkRoster(res.rows, state.profiles, SuiteData.normBadge,
      ScheduleCore.linkIndex(state.stores.timeclockLinks));
    /* Approved time off is applied here rather than inside buildCoverage,
       because it is keyed by badge and a row only has one once the roster join
       above has run. */
    ScheduleCore.applyTimeOff(res,
      TimeOffCore.excusedIndex(state.stores.timeOff, SuiteData.normBadge),
      ScheduleCore.isoDate(coverageAsOf()), TimeOffCore.excusedOn);
    return res;
  }

  function covDrop(kind, step, title, desc, fileName, meta) {
    return '<section class="suite-panel source-panel"><div class="source-step">' + step + '</div>' +
      '<h3>' + esc(title) + '</h3><p>' + esc(desc) + '</p>' +
      (fileName ? '<div class="cov-file"><strong>' + esc(fileName) + '</strong><span>' + esc(meta) + '</span></div>' : '') +
      '<label class="suite-btn ' + (fileName ? '' : 'primary') + ' cov-pick">' +
      (fileName ? 'Replace file' : 'Choose file') +
      '<input type="file" accept=".xlsx,.xls,.csv" data-cov="' + kind + '"></label></section>';
  }

  function covSaveNote() {
    var c = state.coverage;
    if (c.saving) return '<div class="cov-saved saving">Saving ' + esc(c.saving) + ' to Firebase…</div>';
    if (c.savedAt) return '<div class="cov-saved">Saved to Firebase at ' + esc(c.savedAt) + '</div>';
    return '';
  }
  function plxMeta() {
    var sync = state.plx.sync;
    if (!sync || !sync.syncedAt) return '';
    return '<b>' + esc(sync.shiftTags || 0) + '</b> shift tags · <b>' + esc(sync.openOrders || 0) +
      '</b> open orders · ' + esc(ageLabel(sync.syncedAt));
  }

  function covSources() {
    var c = state.coverage;
    var presMeta = '';
    if (c.presence) {
      var on = c.presence.people.filter(function (p) { return p.present; }).length;
      presMeta = c.presence.people.length + ' associates · ' + on + ' on premise';
    }
    return '<div class="cov-sources">' +
      covDrop('workbook', 1, 'PLX workbook',
        'The GEODIS spreadsheet. Refreshes the roster, shift tags, open orders and attendance ' +
        'points in one pass. Upload it whenever you run attendance.',
        state.plx.sync && state.plx.sync.fileName, plxMeta()) +
      covDrop('presence', 2, 'On premise now',
        'The "On Premise - Simple" export (.csv). Drop a fresh one any time to re-check the floor.',
        c.presenceFile, presMeta) +
      '</div>';
  }

  // The on-premise rows carry no timestamp of their own; the export time in the
  // file name is the report's as-of, and everything downstream depends on it, so it
  // is shown and editable rather than assumed.
  function covControls(res) {
    var c = state.coverage;
    return '<section class="suite-panel"><div class="filter-row cov-controls">' +
      '<label class="cov-ctl"><span>As of</span>' +
      '<input class="suite-input" type="datetime-local" id="cov-asof" value="' + esc(dtValue(coverageAsOf())) + '"></label>' +
      '<button class="suite-btn" data-cov-now="1">Now</button>' +
      '<label class="cov-ctl"><span>Grace after start</span>' +
      '<input class="suite-input cov-num" type="number" min="0" max="120" step="5" id="cov-grace" value="' + esc(c.grace) + '"> min</label>' +
      '<span class="cov-asof-note">' + esc(coverageAsOf().toLocaleString()) + '</span>' +
      '<button class="suite-btn danger" data-cov-clear="1">Clear files</button>' +
      '</div></section>';
  }

  /* What the PTO record says, on the row it explains.

     The second case is the one worth calling out: somebody with approved time
     off who is on the clock anyway. They are left as working, because they are
     -- but a supervisor should see the contradiction rather than have it
     smoothed over, since the request may need cancelling before it is paid. */
  function ptoNote(r) {
    if (!r.ptoRequest) return '';
    var when = r.ptoRequest.start +
      (r.ptoRequest.end && r.ptoRequest.end !== r.ptoRequest.start ? ' to ' + r.ptoRequest.end : '');
    if (r.status === 'pto') {
      return '<div class="sub">' + esc(r.ptoRequest.type || 'PTO') + ' approved · ' + esc(when) + '</div>';
    }
    return '<div class="sub warn-text">On premise despite approved ' +
      esc(r.ptoRequest.type || 'PTO') + ' · ' + esc(when) + '</div>';
  }

  /* An occurrence on a day the person had approved off keeps its place on the
     ledger and loses its points. Showing the original struck through is the
     honest form: something WAS logged, and this is why it costs nothing. */
  function ptoPoints(a) {
    if (!a.excusedBy) return esc(a.points || 0);
    return '<span class="pts-void">' + esc(a.originalPoints || 0) + '</span> ' +
      '<b>0</b><div class="sub">' + esc(a.excusedBy.type || 'PTO') + ' approved for this day</div>';
  }

  /* A number on the row that says somebody is missing.

     The workflow this serves is looking the person up in TextUs and Vonage,
     both of which are searched by number -- so it is one click to copy, and a
     tel: link for a phone. A number matched only on a name says so: it is worth
     less confidence than one somebody typed against a badge, and ringing the
     wrong person is the failure worth avoiding. */
  function phoneCell(p, opts) {
    opts = opts || {};
    if (!p || !p.badge) return '<span class="sub">—</span>';
    if (!p.phone) {
      return '<button class="suite-btn tiny" data-phone-edit="' + esc(p.badge) + '">Add number</button>';
    }
    var byName = /name/i.test(p.phoneSource || '') || (p.phoneSource || '').indexOf('workbook') === 0;
    return '<div class="phone-cell">' +
      '<a class="phone-num" href="tel:' + esc(ContactsCore.e164(p.phone)) + '">' +
      esc(ContactsCore.format(p.phone)) + '</a>' +
      '<button class="suite-btn tiny" data-phone-copy="' + esc(ContactsCore.format(p.phone)) +
      '" title="Copy for TextUs or Vonage">Copy</button>' +
      (opts.edit ? '<button class="suite-btn tiny" data-phone-edit="' + esc(p.badge) + '">Edit</button>' : '') +
      (p.phoneSource ? '<div class="sub">' + esc(p.phoneSource) + '</div>' : '') +
      '</div>';
  }

  /* Minutes late, or minutes short. Only a hand-logged occurrence carries one:
     the workbook records what happened and on which day, never for how long, so
     every imported row is 0. Shown as a dash rather than a zero, so the column
     does not read as "nobody was ever late by any amount". */
  function minutesCell(a) {
    var m = Number(a.minutes) || 0;
    return m ? esc(m) : '<span class="sub">&mdash;</span>';
  }

  /* Attendance rows reaching no profile are two different things, and lumping
     them together made an ordinary state look like a fault.

     Most are history: an occurrence from a past year for somebody no longer on
     assignment. The roster is the CURRENT active-assignment snapshot, so those
     can never match and there is nothing to fix.

     Worth chasing are current occurrences for people who ought to be on it.
     Only those get a warning. */
  function orphanNote(orphans) {
    if (!orphans.length) return '';
    var hist = orphans.filter(function (a) { return a.historical; });
    var live = orphans.filter(function (a) { return !a.historical; });
    var out = '';
    if (live.length) {
      out += '<div class="warn-banner"><b>' + live.length + '</b> current attendance record' +
        (live.length === 1 ? '' : 's') + ' reach no profile, so they are counted nowhere. ' +
        'The workbook carries no badge, so these are matched on the name -- connect the person ' +
        'or correct the spelling at source.</div>';
    }
    if (hist.length) {
      out += '<div class="cov-saved"><b>' + hist.length + '</b> historical record' +
        (hist.length === 1 ? '' : 's') + ' belong to people who are not on the current ' +
        'active-assignment roster. Expected for past years, and they carry no points.</div>';
    }
    return out;
  }

  function covMetrics(s) {
    var cov = s.coverage == null ? '—' : s.coverage + '%';
    return '<div class="metric-strip">' +
      metric('Coverage now', cov, s.byStatus.working + ' of ' + s.onShift + ' on-shift associates present',
        s.coverage == null ? '' : s.coverage >= 90 ? 'green' : 'orange') +
      metric('Working', s.byStatus.working, 'On shift and on premise', 'green') +
      metric('Not clocked in', s.byStatus.missing, 'On shift, not on premise', s.byStatus.missing ? 'orange' : 'green') +
      (s.byStatus.notInReport
        ? metric('Not in timeclock', s.byStatus.notInReport, 'Scheduled, but absent from the report entirely', 'orange')
        : s.onPto ? metric('On PTO', s.onPto, 'Approved time off, so not counted against coverage')
        : metric('Unscheduled', s.byStatus.unscheduled, 'On premise with no shift covering now',
                 s.byStatus.unscheduled ? 'orange' : 'green')) +
      '</div>';
  }

  /* When the two reports describe different people there is nothing to report --
     showing "0% coverage, 0 working" would be a confident lie. Replace the whole
     metric strip with what actually went wrong and how to fix it. */
  function covMismatch(res) {
    var o = res.overlap;
    var sites = function (list) {
      return list.length
        ? list.map(function (x) { return '<span class="site-tag">' + esc(x) + '</span>'; }).join('')
        : '<span class="site-tag">unnamed</span>';
    };
    return '<div class="cov-mismatch">' +
      '<strong>These two reports cover different sites</strong>' +
      '<p>None of the <b>' + o.scheduled + '</b> scheduled people appear in the on-premise report, so ' +
      'no coverage can be calculated.</p>' +
      '<div class="site-rows">' +
      '<div><span>Weekly schedule</span>' + sites(o.scheduleSites) + '</div>' +
      '<div><span>On premise</span>' + sites(o.presenceSites) + '</div>' +
      '</div>' +
      '<p>Load the weekly schedule exported for the same site as the on-premise report.</p>' +
      '</div>';
  }

  function scheduleSourceNote(res) {
    if (res.scheduleSource !== 'workbook') return '';
    var gaps = res.scheduleGaps || [];
    return '<div class="sched-source">Scheduled from the <b>PLX workbook</b>' +
      (gaps.length ? ' · <span class="warn-text">' + gaps.length + ' associate(s) have a shift the Key ' +
        'gives no single set of hours for, so they cannot be scheduled</span>' : '') +
      '</div>';
  }

  function covWarnings(res) {
    var c = state.coverage, notes = [];
    var day = ScheduleCore.isoDate(coverageAsOf());
    /* An on-premise row that reaches no profile is invisible everywhere else --
       no attendance, no points, no profile view -- so it is called out first and
       loudest rather than left to be noticed. */
    (res.scheduleGaps || []).slice(0, 1).forEach(function () {
      var byPlace = {};
      (res.scheduleGaps || []).forEach(function (g) {
        var k = g.building + ' ' + g.shift;
        byPlace[k] = (byPlace[k] || 0) + 1;
      });
      notes.push((res.scheduleGaps || []).length + ' associate(s) cannot be scheduled from the workbook: ' +
        Object.keys(byPlace).map(function (k) { return k + ' (' + byPlace[k] + ')'; }).join(', ') +
        '. The Geodis Key lists more than one set of hours for those, so fix it there.');
    });
    var unlinked = ScheduleCore.unlinkedRows(res.rows);
    if (unlinked.length) {
      notes.unshift(unlinked.length + ' associate(s) on the clock are not connected to a ' +
        'profile, so nothing they do reaches attendance or their record. Use Connect on those rows.');
    }
    if (res.summary.noSchedule) {
      notes.push(res.summary.noSchedule + ' associate(s) on the on-premise report have no row in the weekly schedule.');
    }
    var noClock = res.summary.byStatus.notInReport || 0;
    if (noClock) {
      notes.unshift(noClock + ' scheduled associate(s) have no row in the on-premise report at all. ' +
        'The report lists everyone active in the timeclock, so these have not been set up there yet -- ' +
        'usually a new starter. They are not counted as absent and cannot be given attendance points; ' +
        'raise a task to get them added.');
    }
    (res.warnings || []).forEach(function (w) { notes.push(w); });
    if (!notes.length) return '';
    return '<div class="warn-banner cov-warn"><strong>Check these before acting on the numbers</strong><ul>' +
      notes.slice(0, 12).map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') +
      (notes.length > 12 ? '<li>…and ' + (notes.length - 12) + ' more.</li>' : '') + '</ul></div>';
  }

  function covFilters(res) {
    var c = state.coverage;
    var locs = {};
    res.rows.forEach(function (r) { var l = locLeaf(r.location); if (l) locs[l] = (locs[l] || 0) + 1; });
    var opts = [['exceptions', 'Exceptions only'], ['onshift', 'On shift now'], ['all', 'Everyone']]
      .concat(ScheduleCore.STATUS_ORDER.map(function (k) {
        return [k, ScheduleCore.STATUS[k].label + ' (' + res.summary.byStatus[k] + ')'];
      }));
    return '<div class="filter-row">' +
      '<input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="Search by EID, name, badge, timeclock id, or supervisor…">' +
      '<select class="suite-select" id="cov-status">' + opts.map(function (o) {
        return '<option value="' + o[0] + '" ' + (c.statusFilter === o[0] ? 'selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select>' +
      '<select class="suite-select" id="cov-loc"><option value="all">All locations</option>' +
      Object.keys(locs).sort().map(function (l) {
        return '<option value="' + esc(l) + '" ' + (c.location === l ? 'selected' : '') + '>' + esc(l) + ' (' + locs[l] + ')</option>';
      }).join('') + '</select></div>';
  }

  function covFilter(rows) {
    var c = state.coverage, q = state.query.trim().toLowerCase();
    return rows.filter(function (r) {
      // A row that never reached the roster has no market of its own. It stays
      // visible rather than vanishing on a market change -- this is the view
      // whose whole job is surfacing people who are not where they should be.
      if (state.market !== 'all' && r.market && r.market !== state.market) return false;
      if (c.location !== 'all' && locLeaf(r.location) !== c.location) return false;
      if (c.statusFilter === 'exceptions') { if (r.severity !== 'bad' && r.severity !== 'warn') return false; }
      else if (c.statusFilter === 'onshift') { if (!ScheduleCore.STATUS[r.status].onShift) return false; }
      else if (c.statusFilter !== 'all' && r.status !== c.statusFilter) return false;
      if (!q) return true;
      return searchText(r.badge ? profile(r.badge) : null,
        r.name + ' ' + r.badge + ' ' + r.wfmId + ' ' + r.manager + ' ' + r.job)
        .toLowerCase().indexOf(q) !== -1;
    });
  }

  function covShiftCell(r) {
    if (r.dayCode) return '<span class="cov-code">' + esc(r.dayCode) + '</span>';
    if (!r.shiftRaw) return '<span class="score none">Not scheduled</span>';
    var flags = (r.overnight ? '<span class="cov-flag">overnight</span>' : '') +
      (r.suspectShift ? '<span class="cov-flag bad" title="This shift length looks like a typo in the source report.">check</span>' : '');
    var when = r.minutesIntoShift != null ? Math.floor(r.minutesIntoShift / 60) + 'h' + (r.minutesIntoShift % 60) + 'm in'
      : r.minutesUntilShift != null ? 'starts in ' + Math.floor(r.minutesUntilShift / 60) + 'h' + (r.minutesUntilShift % 60) + 'm'
      : '';
    return '<div class="name">' + esc(r.shiftRaw) + ' ' + flags + '</div>' +
      (when ? '<div class="sub">' + esc(when) + '</div>' : '');
  }

  /* Only a person who was not where they should be gets a documentation box --
     there is nothing to explain about someone who is working their shift. */
  function covDocCell(r) {
    /* Somebody with no timeclock record is not an absence to explain, so the
       disposition list is withheld rather than offered. Every option on it
       describes a reason for not being at work, and picking one would put a
       system gap on somebody's attendance record. What is offered instead is
       the thing that actually needs doing. */
    if (r.status === 'notInReport') {
      return '<button class="suite-btn tiny" data-add-clock="' + esc(r.badge || '') +
        '" data-add-clock-name="' + esc(r.rosterName || r.name) + '">Raise a task</button>';
    }
    return covDocFor(ScheduleCore.personKey(r), r.name, r.badge, r.severity);
  }
  function covDocFor(key, name, badge, severity) {
    if (severity !== 'bad' && severity !== 'warn') return '<span class="sub">—</span>';
    var r = { name: name, badge: badge };
    var doc = documentedFor(key);
    var occ = doc && doc.disposition ? DISPOSITION_OCCURRENCE[doc.disposition] : undefined;
    return '<div class="cov-doc">' +
      '<select class="suite-select cov-disp" data-doc-key="' + esc(key) + '" data-doc-name="' + esc(r.name) +
      '" data-doc-badge="' + esc(r.badge || '') + '">' +
      DISPOSITIONS.map(function (o) {
        return '<option value="' + esc(o) + '" ' + (doc && doc.disposition === o ? 'selected' : '') + '>' +
          esc(o || 'Not documented') + '</option>';
      }).join('') + '</select>' +
      '<input class="suite-input cov-reason" data-doc-key="' + esc(key) + '" data-doc-name="' + esc(r.name) +
      '" data-doc-badge="' + esc(r.badge || '') + '" value="' + esc(doc ? doc.reason : '') +
      '" placeholder="Reason…">' +
      /* What this day is worth, said rather than written. The occurrence itself
         belongs on the PLX workbook: logging it here would put a point balance
         in the tool that the sheet the site runs on never hears about. */
      (occ ? '<span class="cov-occ" title="Log this on the attendance tab of the PLX workbook.">' +
        esc(occ.type) + ' · ' + esc(occ.points) + ' pt' + (occ.points === 1 ? '' : 's') +
        ' on the workbook</span>' : '') +
      (occ === null ? '<span class="cov-excused">Excused · no points</span>' : '') +
      '</div>';
  }
  function documentedFor(key) {
    var src = state.coverage.reviewDate ? state.coverage.reviewDay : state.coverage.storedDay;
    return ((src && src.documented) || {})[key] || null;
  }

  /* ---------- export for the GEODIS headcount spreadsheet ----------
     Rebuilds one branch's shift block as the six columns those sheets share, to
     be pasted at the block's "Employee  Name" cell. */
  function covExport(res) {
    var c = state.coverage;
    if (!c.exportOpen) {
      return '<section class="suite-panel"><div class="suite-panel-head"><h2>Headcount spreadsheet</h2>' +
        '<div class="suite-actions"><button class="suite-btn" data-export-toggle>Build a paste for a branch</button></div>' +
        '</div><p class="perf-note">Rebuild a branch\u2019s shift block in the GEODIS spreadsheet layout.</p></section>';
    }
    var locs = {};
    res.rows.forEach(function (r) {
      var l = ScheduleCore.locationLeaf(r.location);
      if (l) locs[l] = true;
    });
    var locList = Object.keys(locs).sort();
    var ex = ScheduleCore.spreadsheetExport(res, {
      location: c.exportLoc, shift: c.exportShift,
      profiles: state.profiles,
      documented: (c.storedDay && c.storedDay.documented) || {}
    });
    return '<section class="suite-panel"><div class="suite-panel-head"><h2>Headcount spreadsheet</h2>' +
      '<div class="suite-actions"><button class="suite-btn" data-export-toggle>Hide</button></div></div>' +
      '<div class="filter-row cov-controls">' +
      '<label class="cov-ctl">Branch<select class="suite-select" id="export-loc">' +
      '<option value="all">All</option>' + locList.map(function (l) {
        return '<option value="' + esc(l) + '" ' + (c.exportLoc === l ? 'selected' : '') + '>' + esc(l) + '</option>';
      }).join('') + '</select></label>' +
      '<label class="cov-ctl">Shift<select class="suite-select" id="export-shift">' +
      ScheduleCore.shiftLabelsIn(res, state.profiles).concat(['all']).map(function (v) {
        return '<option value="' + v + '" ' + (c.exportShift === v ? 'selected' : '') + '>' +
          (v === 'all' ? 'All shifts' : v) + '</option>';
      }).join('') + '</select></label>' +
      '<div class="export-trio"><span>Expected<b>' + ex.summary.expected + '</b></span>' +
      '<span>Onsite<b>' + ex.summary.onsite + '</b></span>' +
      '<span class="' + (ex.summary.short ? 'short' : '') + '">Short<b>' + ex.summary.short + '</b></span></div>' +
      '<button class="suite-btn primary" data-copy-sheet>Copy ' + ex.rows.length + ' rows</button>' +
      '</div>' +
      '<p class="export-hint">Paste at the <b>Employee&nbsp;&nbsp;Name</b> cell of that block. These six columns sit together on every branch sheet, so the leading Transition / Dept columns are left untouched.</p>' +
      (ex.rows.length ? '<div class="suite-table-wrap"><table class="suite-table export-preview"><thead><tr>' +
        ex.columns.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        ex.rows.slice(0, MAX_ROWS).map(function (r) {
          return '<tr class="' + (r.present ? '' : 'cov-row bad') + '"><td>' + esc(r.name) + '</td><td>' + esc(r.eid) + '</td>' +
            '<td>' + esc(r.startDate || '—') + '</td><td>' + esc(r.shift) + '</td>' +
            '<td>' + esc(r.points === '' ? '—' : r.points) + '</td><td>' + esc(r.comments) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : empty('Nobody is scheduled for that branch and shift', 'Try another branch or shift.')) +
      '</section>';
  }

  /* ---------- reviewing a stored check ----------
     Anyone can open a pull someone else uploaded. A stored check holds the
     summary, full detail on every exception, and a key list of who was on
     premise -- not a row per person -- so the review shows exactly that and
     says so, rather than implying it can rebuild the whole comparison. */
  function covReviewPicker() {
    var c = state.coverage;
    var dates = c.dates.slice().sort().reverse();
    if (!dates.length && !c.reviewDate) return '';
    var checks = (c.reviewDay && c.reviewDay.checks) || [];
    return '<div class="filter-row cov-controls cov-review-bar">' +
      '<label class="cov-ctl">Review a stored check<select class="suite-select" id="review-date">' +
      '<option value="">Current upload</option>' +
      dates.map(function (d) {
        return '<option value="' + esc(d) + '" ' + (c.reviewDate === d ? 'selected' : '') + '>' + esc(d) + '</option>';
      }).join('') + '</select></label>' +
      (c.reviewDate
        ? '<label class="cov-ctl">Pull<select class="suite-select" id="review-check">' +
          (checks.length
            ? checks.map(function (ck) {
                return '<option value="' + esc(ck.id) + '" ' + (c.reviewId === ck.id ? 'selected' : '') + '>' +
                  esc((ck.asOf || '').slice(11, 16) || ck.id) +
                  (ck.summary && ck.summary.coverage != null ? ' · ' + ck.summary.coverage + '%' : '') +
                  '</option>';
              }).join('')
            : '<option value="">No checks stored that day</option>') +
          '</select></label>' +
          '<button class="suite-btn" data-review-exit>Back to current upload</button>'
        : '') +
      '</div>';
  }

  function reviewedCheck() {
    var c = state.coverage;
    if (!c.reviewDate || !c.reviewDay) return null;
    var checks = c.reviewDay.checks || [];
    if (!checks.length) return null;
    return checks.filter(function (ck) { return ck.id === c.reviewId; })[0] || checks[checks.length - 1];
  }

  /* Filters for a stored check. Reuses the live view's control ids so the same
     handlers drive both, but the options come from what this check actually
     holds. Everything stored IS an exception, so the live "Exceptions only" and
     "On shift now" have nothing to narrow here and read as All rather than
     silently emptying the table. */
  function covReviewFilters(check) {
    var c = state.coverage;
    var ex = check.exceptions || [];
    var counts = {}, locs = {};
    ex.forEach(function (r) {
      counts[r.status] = (counts[r.status] || 0) + 1;
      var l = locLeaf(r.location);
      if (l) locs[l] = (locs[l] || 0) + 1;
    });
    var sel = counts[c.statusFilter] ? c.statusFilter : 'all';
    var opts = [['all', 'All exceptions (' + ex.length + ')']].concat(
      ScheduleCore.STATUS_ORDER.filter(function (k) { return counts[k]; })
        .map(function (k) { return [k, ScheduleCore.STATUS[k].label + ' (' + counts[k] + ')']; }));
    return '<div class="filter-row">' +
      '<input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="Search by EID, name, badge, timeclock id, or supervisor…">' +
      '<select class="suite-select" id="cov-status">' + opts.map(function (o) {
        return '<option value="' + o[0] + '" ' + (sel === o[0] ? 'selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select>' +
      '<select class="suite-select" id="cov-loc"><option value="all">All locations</option>' +
      Object.keys(locs).sort().map(function (l) {
        return '<option value="' + esc(l) + '" ' + (c.location === l ? 'selected' : '') + '>' +
          esc(l) + ' (' + locs[l] + ')</option>';
      }).join('') + '</select></div>';
  }
  function covReviewFilter(rows) {
    var c = state.coverage, q = state.query.trim().toLowerCase();
    var wantStatus = c.statusFilter === 'exceptions' || c.statusFilter === 'onshift' ? 'all' : c.statusFilter;
    return rows.filter(function (r) {
      if (state.market !== 'all') {
        // A stored exception carries no market of its own; take it from the
        // profile. A row that never reached one stays visible, as in the live
        // view -- this is where people who are not where they should be surface.
        var p = r.badge ? profile(r.badge) : null;
        if (p && p.market !== state.market) return false;
      }
      if (wantStatus !== 'all' && r.status !== wantStatus) return false;
      if (c.location !== 'all' && locLeaf(r.location) !== c.location) return false;
      if (!q) return true;
      return (r.name + ' ' + r.badge + ' ' + r.wfmId + ' ' + r.manager + ' ' + r.job)
        .toLowerCase().indexOf(q) !== -1;
    });
  }

  function covReview(check) {
    var c = state.coverage;
    var all = check.exceptions || [];
    var ex = covReviewFilter(all);
    var present = (check.presentKeys || []).length;
    return '<div class="review-banner"><strong>Stored check · ' + esc(c.reviewDate) + ' ' +
      esc((check.asOf || '').slice(11, 16)) + '</strong>' +
      '<span>' + esc(check.fileName || 'uploaded report') + ' · ' + present + ' on premise · ' +
      ex.length + ' exception' + (ex.length === 1 ? '' : 's') + '</span></div>' +
      covMetrics(check.summary || { byStatus: {}, onShift: 0, coverage: null }) +
      '<section class="suite-panel">' + covReviewFilters(check) +
      (ex.length
        ? '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
          '<th>Associate</th><th>Status</th><th>Scheduled shift</th><th>Location</th>' +
          '<th>Supervisor</th><th>Documented</th></tr></thead><tbody>' +
          ex.slice(0, MAX_ROWS).map(function (r) {
            var st = ScheduleCore.STATUS[r.status] || { label: r.status, severity: '' };
            var open = r.badge ? ' data-profile="' + esc(r.badge) + '"' : '';
            return '<tr class="cov-row ' + st.severity + '">' +
              '<td><div class="' + (r.badge ? 'name link' : 'name') + '"' + open + '>' + esc(r.name) + '</div>' +
              '<div class="sub">' + (r.badge ? idLine(profile(r.badge)) || 'Badge ' + esc(r.badge)
                : esc(r.wfmId ? 'Timeclock ' + r.wfmId : 'No id')) + '</div></td>' +
              '<td><span class="cov-status ' + st.severity + '">' + esc(st.label) + '</span></td>' +
              '<td>' + esc(r.shift || '—') + '</td>' +
              '<td>' + esc(locLeaf(r.location) || '—') + '</td>' +
              '<td>' + esc(r.manager || '—') + '</td>' +
              '<td>' + covDocFor(r.key, r.name, r.badge, st.severity) + '</td></tr>';
          }).join('') + '</tbody></table></div>' + rowCap(Math.min(ex.length, MAX_ROWS), ex.length)
        : empty(all.length ? 'Nothing matches those filters' : 'No exceptions in this check',
                all.length ? 'Widen the status, location, or market filter to see more.'
                           : 'Everyone on shift was on premise at that moment.')) +
      '<p class="export-hint">A stored check keeps full detail on every exception and a list of who was on ' +
      'premise. It does not keep a row per person, so the table above is the exceptions only.</p>' +
      '</section>';
  }

  function unlinkedBanner(res) {
    var unlinked = ScheduleCore.unlinkedRows(res.rows);
    var absent = ScheduleCore.unlinkedAbsent(res.rows);
    if (!unlinked.length) return '';
    return '<div class="warn-banner cov-unlinked"><strong>' + unlinked.length +
      ' not connected to a profile</strong>' +
      '<p>These people are on the clock but reach no associate record, so their attendance, points ' +
      'and time off go nowhere. Connecting one fixes it for every future upload.</p>' +
      (absent.length ? '<p class="sub">' + absent.length + ' more are unconnected but not on the clock, ' +
        'so they are not listed. They appear here if they punch in.</p>' : '') +
      // The whole backlog, not just whoever happens to be on the clock right now.
      '<p class="sub">Settings → Connections lists every workbook associate who reaches no profile, ' +
      'with the closest roster name suggested. <button class="suite-btn tiny" data-open-connections="1">' +
      'Review all connections</button></p>' +
      '<div class="unlinked-list">' + unlinked.slice(0, 12).map(function (r) {
        return '<button class="unlinked-row" data-link-eid="' + esc(r.wfmId || '') +
          '" data-link-name="' + esc(r.name) + '">' +
          '<span class="name">' + esc(r.name) + '</span>' +
          '<span class="sub">' + esc(r.wfmId || 'no timeclock id') + '</span>' +
          '<span>Connect ›</span></button>';
      }).join('') +
      (unlinked.length > 12 ? '<div class="sub">…and ' + (unlinked.length - 12) + ' more in the table below.</div>' : '') +
      '</div></div>';
  }

  function covTable(rows, total) {
    return '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
      '<th>Associate</th><th>Status</th><th>On premise</th><th>Mobile</th><th>Scheduled shift</th>' +
      '<th>Location</th><th>Job</th><th>Supervisor</th><th>Documented</th></tr></thead><tbody>' +
      rows.slice(0, MAX_ROWS).map(function (r) {
        // Only a row that reached a roster profile can open one.
        var open = r.badge ? ' data-profile="' + esc(r.badge) + '"' : '';
        var nameCls = r.badge ? 'name link' : 'name';
        var sub = r.badge
          ? (idLine(profile(r.badge)) || 'Badge ' + esc(r.badge)) +
            (r.rosterMatch === 'name' ? ' · matched by name' : r.rosterMatch === 'linked' ? ' · connected by hand' : '')
          : '<b class="warn-text">Not connected</b> · ' + esc(r.wfmId || 'no timeclock id') +
            ' <button class="suite-btn tiny" data-link-eid="' + esc(r.wfmId || '') +
            '" data-link-name="' + esc(r.name) + '">Connect…</button>';
        return '<tr class="cov-row ' + r.severity + '">' +
          '<td><div class="' + nameCls + '"' + open + '>' + esc(r.name) + '</div><div class="sub">' + sub +
          (r.inSchedule ? '' : ' · no schedule row') + (r.ambiguous ? ' · duplicate name' : '') + '</div></td>' +
          '<td><span class="cov-status ' + r.severity + '">' + esc(r.statusLabel) + '</span>' + ptoNote(r) + '</td>' +
          '<td>' + (r.present ? '<span class="cov-dot on">Yes</span>' : '<span class="cov-dot off">No</span>') + '</td>' +
          /* Only where somebody is not where they should be. A number against
             every row would be a column of noise on a normal day. */
          '<td>' + (r.severity === 'bad' || r.severity === 'warn'
            ? phoneCell(r.badge ? profile(r.badge) : null) : '<span class="sub">—</span>') + '</td>' +
          '<td>' + covShiftCell(r) + '</td>' +
          '<td>' + esc(locLeaf(r.location) || '—') + '</td>' +
          '<td>' + esc(r.job || '—') + '</td>' +
          '<td>' + esc(r.manager || '—') + '</td>' +
          '<td>' + covDocCell(r) + '</td></tr>';
      }).join('') + '</tbody></table></div>' + rowCap(Math.min(rows.length, MAX_ROWS), rows.length);
  }

  function coverageView() {
    var c = state.coverage;
    var head = hero('On-Premise', 'The weekly schedule crossed with the on-premise snapshot. Both are saved to Firebase, so absences stay documented.') +
      covSources() + covSaveNote();
    /* Reviewing comes first: the point of it is reading a pull SOMEONE ELSE
       uploaded, so it must not require having loaded the reports yourself. */
    var reviewing = reviewedCheck();
    if (reviewing) return head + covReviewPicker() + covReview(reviewing);
    var sched = activeSchedule();
    if (!sched || !c.presence) {
      var need = !sched && !c.presence ? 'the PLX workbook and the on-premise export'
        : !sched ? 'the PLX workbook, which carries the schedule' : 'the on-premise export';
      return head + covReviewPicker() + '<section class="suite-panel"><div class="workflow-empty">' +
        'Load ' + esc(need) + ' above to see who is scheduled right now and who is actually on premise' +
        (state.coverage.dates.length ? ', or open a stored check above.' : '.') +
        '</div></section>';
    }
    var res = buildCoverageResult();
    // Nothing below the sources means anything if the reports do not pair up.
    if (res.mismatch) return head + covReviewPicker() + covMismatch(res);
    var rows = covFilter(res.rows);
    return head + covReviewPicker() + covControls(res) + covMetrics(res.summary) +
      scheduleSourceNote(res) + unlinkedBanner(res) + covWarnings(res) + covExport(res) +
      '<section class="suite-panel">' + covFilters(res) +
      (rows.length ? covTable(rows, res.rows.length)
        : empty('Nothing matches those filters', 'Widen the status or location filter to see more.')) +
      '</section>';
  }

  /* The workbook cannot be fetched: it lives in another Microsoft tenant, which
     no automation here can reach. So it is uploaded, and this sends it whole to
     be parsed server-side -- the same code path the automated push would have
     used, so an upload and a push cannot produce different results. */
  function readPlxUpload(file) {
    state.plx.busy = true;
    state.plx.note = 'Reading ' + file.name + '…';
    render();
    var reader = new FileReader();
    reader.onload = function (e) {
      var bytes = new Uint8Array(e.target.result), chunk = 0x8000, parts = [];
      // Chunked, because a 500KB workbook overflows the argument list if the
      // whole array is spread into fromCharCode at once.
      for (var i = 0; i < bytes.length; i += chunk) {
        parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
      }
      var actor = currentActor(false);
      state.plx.note = 'Uploading ' + file.name + '…';
      render();
      SuiteData.uploadPlx({
        fileBase64: btoa(parts.join('')),
        fileName: file.name,
        modifiedAt: new Date(file.lastModified).toISOString(),
        uploadedBy: actor ? actor.name : ''
      }).then(function (r) {
        state.plx.sync = r.sync || null;
        state.plx.note = plxSummary(r);
        return SuiteData.loadAll();
      }).then(function (stores) {
        state.stores = stores;
        rebuild();
      }).catch(function (err) {
        state.plx.note = 'Upload failed: ' + err.message;
      }).then(function () {
        state.plx.busy = false;
        render();
      });
    };
    reader.onerror = function () {
      state.plx.busy = false;
      state.plx.note = 'Could not read ' + file.name + '.';
      render();
    };
    reader.readAsArrayBuffer(file);
  }
  function plxSummary(r) {
    var s = r.sync || {}, a = r.attendance || {};
    var bits = [(s.shiftTags || 0) + ' shift tags across ' + (s.sites || 0) + ' sites',
      (s.openOrders || 0) + ' open orders'];
    if (a.error) bits.push('attendance failed: ' + a.error);
    else if (a.skipped) bits.push('attendance skipped (' + a.skipped + ')');
    else if (a.total != null) bits.push(a.total + ' attendance rows, ' + (a.matched || 0) + ' matched');
    return 'Refreshed · ' + bits.join(' · ');
  }

  function readCoverageFile(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(e.target.result, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        // raw:false keeps the day header as "8/25/2026" text, which is what maps a
        // merged column to its date; cellDates would turn it into a Date and lose
        // the alignment the parser depends on.
        var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
        var pres = ScheduleCore.parseOnPremise(aoa);
        if (!pres.people.length) {
          throw new Error(pres.warnings[0] || 'No employee rows were found. Is this the "On Premise - Simple" export?');
        }
        state.coverage.presence = pres;
        state.coverage.presenceFile = file.name;
        // Each upload re-dates the check from the export time in the file name.
        state.coverage.asOf = ScheduleCore.asOfFromFileName(file.name) || new Date();
        persistCheck(file.name);
        render();
      } catch (err) {
        console.error(err);
        alert('Could not read "' + file.name + '".\n\n' + err.message);
      }
    };
    reader.onerror = function () { alert('Failed to read "' + file.name + '". Try again.'); };
    reader.readAsArrayBuffer(file);
  }

  /* Attendance is not entered here, so the page has to say where it IS entered
     and how stale the copy on screen is. A read-only table with no explanation
     reads as a broken page; one that names the sheet and links to it reads as
     the sheet's window, which is what it is. */
  function workbookNote() {
    var sync = state.plx.sync;
    return '<section class="suite-panel plx-bar"><div class="plx-info">' +
      '<strong>Logged on the PLX workbook</strong>' +
      '<span>Occurrences and points are recorded on the workbook\u2019s attendance tab, not in this ' +
      'tool. This page reads that sheet, so anything typed here would never reach it \u2014 log it ' +
      'on the workbook and it appears here on the next upload.</span>' +
      (sync && sync.syncedAt
        ? '<span>Last read from the workbook ' + esc(shortWhen(sync.syncedAt)) +
          ' (' + esc(ageLabel(sync.syncedAt)) + ').</span>'
        : '<span class="warn-text">No workbook has been uploaded yet, so nothing has been read from ' +
          'the attendance tab. Upload it on the On-Premise page.</span>') +
      '</div></section>';
  }

  /* ---------- attendance ---------- */
  function attendance() {
    if (!state.records) return needsRoster();
    if (!state.storesLoaded) return loadingPanel('attendance records');
    var q = state.query.trim().toLowerCase();
    var all = state.stores.attendance.filter(function (a) {
      var p = profile(a.badge);
      if (!inMarket(p)) return false;
      if (!q) return true;
      return searchText(p, a.badge + ' ' + a.type + ' ' + a.date).toLowerCase().indexOf(q) !== -1;
    });
    all = sortRows(all, 'attendance', function (a, k) {
      var pr = profile(a.badge);
      if (k === 'location') return pr ? pr.locationLabel : '';
      if (k === 'name') return pr ? pr.name : (a.badge || '');
      if (k === 'points') return Number(a.points) || 0;
      return a[k] == null ? '' : a[k];
    });
    var rows = all.slice(0, MAX_ROWS);
    var orphans = SuiteData.unmatched(state.profiles, state.stores.attendance);

    return heroLink('Attendance',
        'Occurrences and points read from the PLX workbook, joined to the assignment roster by badge.',
        PLX_ATTENDANCE_URL, 'Open the attendance tab') +
      workbookNote() +
      orphanNote(orphans) +
      '<section class="suite-panel">' +
      '<div class="filter-row"><input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="Search by EID, name, badge, type, or date…"></div>' +
      (rows.length ? '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
        sortHead('attendance', 'date', 'Date') +
        sortHead('attendance', 'name', 'Associate') +
        sortHead('attendance', 'location', 'Site / account') +
        sortHead('attendance', 'type', 'Type') +
        '<th title="Minutes late or short. The workbook records what happened and on which day, never for how long, so only occurrences logged by hand before this page went read-only carry one.">Minutes</th>' +
        sortHead('attendance', 'points', 'Points') +
        '<th title="This associate\u2019s total across every occurrence -- not a running total down this table.">Balance</th>' +
        '<th>Notes</th></tr></thead><tbody>' +
        rows.map(function (a) {
          var p = profile(a.badge);
          return '<tr><td>' + esc(a.date) + '</td>' +
            '<td>' + (p ? '<div class="name link" data-profile="' + esc(p.badge) + '">' + esc(p.name) + '</div><div class="sub">' + esc(p.badge) + '</div>'
              : '<div class="name">Badge ' + esc(a.badge) + '</div><div class="sub warn-text">Not on roster</div>') + '</td>' +
            '<td>' + (p && p.location
              ? esc(p.location) + (p.account ? ' <span class="sub">' + esc(p.account) + '</span>' : '')
              : '<span class="sub">—</span>') + '</td>' +
            '<td>' + esc(a.type) + '</td><td>' + minutesCell(a) + '</td>' +
            '<td>' + ptoPoints(a) + '</td>' +
            '<td>' + (p ? '<b>' + esc(p.points) + '</b>' : '<span class="sub">&mdash;</span>') + '</td>' +
            '<td class="detail-cell">' + esc(a.notes || '') +
              (a.source ? '<div class="sub">' + esc(a.source) + '</div>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>' + rowCap(rows.length, all.length)
        : empty('No attendance records',
            'Occurrences arrive with the PLX workbook. Upload it on the On-Premise page to pull the attendance tab through.')) +
      '</section>';
  }

  /* ---------- time off ---------- */
  /* ---------- the shared IL PTO tracker ----------
     One workbook, shared with another branch, where GEODIS PTO sits on three tabs
     and other clients' associates sit on one of them. PtoTrackerCore reads it; the
     rows become ordinary time-off records and go through the same pipeline as the
     Forms intake, so nothing downstream has to know where a request came from.

     A row whose EID reaches no profile is still imported. The Time Off tab already
     surfaces unmatched requests for somebody to connect, and dropping an approved
     day off because the person has left the active roster would lose it. */
  var PTO_TRACKER_SOURCE = 'IL Shared PTO Tracker';

  function ptoTrackerLink() {
    var rows = state.stores.appConfig || state.admin.appConfig || [];
    var r = rows.filter(function (x) { return x.key === 'ilPtoTrackerUrl'; })[0];
    return r ? String(r.value || '').trim() : '';
  }

  // EID (the RC Legacy Contact ID the tracker writes) -> badge.
  function badgeForEid() {
    var map = {};
    allProfiles().forEach(function (p) {
      var e = String(p.empNumber || '').trim();
      if (e && !map[e]) map[e] = p.badge;
    });
    return function (eid) { return map[String(eid || '').trim()] || ''; };
  }

  function ptoImportPanel() {
    var imp = state.ptoImport;
    var link = ptoTrackerLink();
    return '<section class="suite-panel pto-import"><div class="suite-panel-head">' +
      '<h2>Shared IL PTO tracker</h2><div class="suite-actions">' +
      (link ? '<a class="suite-btn" href="' + esc(link) + '" target="_blank" rel="noopener">Open the spreadsheet</a> ' : '') +
      '<label class="suite-btn cov-pick primary">Import tracker' +
      '<input type="file" accept=".xlsx,.xls" data-pto-book></label></div></div>' +
      '<p class="perf-note">The workbook Chicago and St. Louis share. GEODIS PTO is read from the ' +
      '<b>30080</b>, <b>GEODIS - 20062</b> and <b>20062 Geodis Processed</b> tabs; rows on 30080 for other ' +
      'clients are counted and left alone. An import replaces what this tracker last said and does not ' +
      'touch requests from any other source.' +
      (link ? '' : ' <span class="warn-text">No spreadsheet link is set — add one under Settings → RC links.</span>') +
      '</p>' +
      ptoSyncNote() +
      (imp ? shiftImportReport(imp) : '') + '</section>';
  }

  /* What the SharePoint flow last did. The file is watched rather than uploaded,
     so this is normally the only sign it is working -- and the only place the
     held-task warning surfaces. */
  function ptoSyncNote() {
    var s = state.ilPto.sync;
    if (!s || !s.syncedAt) return '';
    var bits = [
      '<b>' + esc(s.requests || 0) + '</b> requests',
      esc(s.matched || 0) + ' matched to an associate',
      s.unmatched ? esc(s.unmatched) + ' not on the roster' : '',
      s.tasksRaised ? '<b class="warn-text">' + esc(s.tasksRaised) + '</b> raised as tasks' : ''
    ].filter(Boolean);
    return '<div class="overview-req-note">Last pulled from SharePoint ' +
      esc(new Date(s.syncedAt).toLocaleString()) +
      (s.fileName ? ' · ' + esc(s.fileName) : '') + ' · ' + bits.join(' · ') + '</div>' +
      ((s.warnings && s.warnings.length)
        ? '<div class="import-report' + (s.tasksHeld ? ' bad' : '') + '"><strong>From that pull</strong><ul>' +
          s.warnings.slice(0, 6).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>'
        : '');
  }

  function readPtoTracker(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(e.target.result, { type: 'array' });
        var sheets = wb.SheetNames.map(function (n) {
          return { name: n, aoa: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }) };
        });
        var parsed = PtoTrackerCore.parseTracker(sheets);
        if (!parsed.sheets.length) {
          throw new Error('None of the GEODIS tabs were found. Expected 30080, GEODIS - 20062 and 20062 Geodis Processed.');
        }
        if (!parsed.requests.length) {
          throw new Error('The GEODIS tabs were read but hold no GEODIS rows.');
        }
        var built = PtoTrackerCore.toTimeOffRecords(parsed, {
          badgeForEid: badgeForEid(), source: PTO_TRACKER_SOURCE, pipeline: TimeOffCore
        });
        var merged = PtoTrackerCore.mergeForSave(state.stores.timeOff, built.records, PTO_TRACKER_SOURCE);
        /* A request that left the sheet without reaching the processed tab is a
           question, not a deletion: its record stays and somebody is asked. */
        var newTasks = PtoTrackerCore.vanishedTasks(merged.vanished, {
          tasks: TasksCore, existing: state.stores.tasks,
          source: PTO_TRACKER_SOURCE, actor: currentActor(false)
        });

        state.ptoImport = { headline: 'Saving ' + built.records.length + ' PTO requests…', warnings: [] };
        render();

        SuiteData.replaceCollection('timeoff', merged.records).then(function () {
          if (!newTasks.length) return null;
          return SuiteData.replaceCollection('tasks', (state.stores.tasks || []).concat(newTasks));
        }).then(function () {
          state.stores.timeOff = merged.records;
          if (newTasks.length) state.stores.tasks = (state.stores.tasks || []).concat(newTasks);
          rebuild();
          var others = Object.keys(parsed.otherClients).map(function (c) {
            return parsed.otherClients[c] + ' ' + c;
          }).join(', ');
          state.ptoImport = {
            headline: built.records.length + ' GEODIS PTO requests imported from ' + parsed.sheets.length +
              ' tab(s) · ' + (built.records.length - built.unmatched.length) + ' reached an associate' +
              (newTasks.length ? ' · ' + newTasks.length + ' left the sheet unprocessed and became a task' : ''),
            warnings: parsed.warnings.concat(
              merged.vanished.length
                ? [merged.vanished.length + ' request(s) are no longer on any tab but never reached the ' +
                   'processed one. Their records are kept as they were' +
                   (newTasks.length ? ' and ' + newTasks.length + ' task(s) were raised to settle them' :
                    ' and a task was already open for them') + '.']
                : [],
              built.unmatched.length
                ? [built.unmatched.length + ' request(s) name somebody who is not on the current roster — ' +
                   'usually a past assignment. They are listed below to connect by hand.']
                : [],
              parsed.nonGeodis
                ? [parsed.nonGeodis + ' row(s) on the shared tabs belong to other clients and were left alone' +
                   (others ? ' (' + others + ')' : '') + '.']
                : [],
              parsed.skipped.length ? ['Tabs not read: ' + parsed.skipped.join(', ') + '.'] : []
            )
          };
          render();
        }).catch(function (err) {
          state.ptoImport = { failed: true, headline: 'Could not save the PTO requests: ' + err.message, warnings: [] };
          render();
        });
      } catch (err) {
        console.error(err);
        state.ptoImport = { failed: true, headline: 'Could not read "' + file.name + '": ' + err.message, warnings: [] };
        render();
      }
    };
    reader.onerror = function () { alert('Failed to read "' + file.name + '".'); };
    reader.readAsArrayBuffer(file);
  }

  function timeoff() {
    if (!state.records) return needsRoster();
    if (!state.storesLoaded) return loadingPanel('time-off requests');
    var q = state.query.trim().toLowerCase();
    var all = state.stores.timeOff.filter(function (t) {
      var p = profile(t.badge);
      // A request from a form carries a name but may have no badge, so it has no
      // market either. Hiding it would lose a PTO request nobody has actioned.
      if (p ? !inMarket(p) : state.market !== 'all' && t.badge) return false;
      if (!q) return true;
      return searchText(p, (p ? '' : t.name || '') + ' ' + t.badge + ' ' + t.type + ' ' +
        t.status + ' ' + (t.source || '')).toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return String(b.start || '').localeCompare(String(a.start || '')); });
    var rows = all.slice(0, MAX_ROWS);

    var orphans = state.stores.timeOff.filter(function (t) { return !profile(t.badge); });
    return hero('PTO / VTO tracking', 'Approved time off is excused and carries no attendance points.', 'timeoff', 'New request') +
      ptoImportPanel() +
      (orphans.length ? '<div class="warn-banner"><b>' + orphans.length + '</b> request' +
        (orphans.length === 1 ? '' : 's') + ' could not be matched to an associate on the roster — usually a ' +
        'name typed differently on the form. They are listed below and still need actioning.</div>' : '') +
      '<section class="suite-panel">' +
      '<div class="filter-row"><input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="Search by EID, name, badge, type, or status…"></div>' +
      (rows.length ? '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
        '<th>Associate</th><th>Type</th><th>Dates</th><th>Hours</th><th>Status</th><th>Attendance tie-in</th><th></th></tr></thead><tbody>' +
        rows.map(function (t) {
          var p = profile(t.badge);
          return '<tr' + (p ? '' : ' class="cov-row warn"') + '><td>' +
            (p ? '<div class="name link" data-profile="' + esc(p.badge) + '">' + esc(p.name) + '</div><div class="sub">' + esc(p.badge) + '</div>'
               : '<div class="name">' + esc(t.name || 'Badge ' + t.badge) + '</div>' +
                 '<div class="sub warn-text">Not matched to a profile</div>') +
            (t.source ? '<div class="sub">' + esc(t.source) + '</div>' : '') + '</td>' +
            '<td><span class="row-type ' + (t.type === 'VTO' ? 'vto' : t.type === 'Sick' ? 'sick' : '') + '">' + esc(t.type) + '</span></td>' +
            '<td>' + esc(t.start) + (t.end && t.end !== t.start ? ' → ' + esc(t.end) : '') + '</td>' +
            '<td>' + esc(t.hours || 0) + (Number(t.transitionHours) > 0 ? '<div class="sub">' +
              esc(t.transitionHours) + ' transition · ' + esc(t.accrualHours || 0) + ' accrual</div>' : '') + '</td>' +
            '<td>' + statusSelect(t) + '</td>' +
            '<td>' + tieIn(t) + '</td>' +
            '<td>' + (p ? '' : '<button class="suite-btn" data-connect="' + esc(t.id) + '">Connect…</button> ') +
            '<button class="suite-btn danger" data-del="timeoff|' + esc(t.id) + '">Remove</button></td></tr>';
        }).join('') + '</tbody></table></div>' + rowCap(rows.length, all.length)
        : empty('No time-off requests')) + '</section>';
  }

  /* A request moves through a pipeline rather than being approved or not, so the
     status is a dropdown. Every change is attributed and logged -- see
     timeoff-core.js. An unrecognised status (older data, or something set by
     hand) is offered as-is rather than quietly relabelled. */
  // Which pipeline governs a collection, so one handler serves both.
  var PIPELINES = { timeoff: TimeOffCore, discrepancies: PayrollCore.pipeline,
    tasks: TasksCore.pipeline };
  var LOCAL_OF = { timeoff: 'timeOff', discrepancies: 'discrepancies', tasks: 'tasks' };

  function statusSelect(t) {
    var meta = TimeOffCore.statusMeta(t.status);
    var keys = TimeOffCore.STATUS_KEYS.slice();
    if (meta.unknown) keys.unshift(meta.key);
    var last = TimeOffCore.lastChange(t);
    return '<select class="suite-select status-select ' + esc(meta.cls) + '" data-status="' + esc(t.id) +
      '" data-status-kind="timeoff"' +
      (last ? ' title="' + esc(changeTitle(t)) + '"' : '') + '>' +
      keys.map(function (k) {
        var m = TimeOffCore.statusMeta(k);
        return '<option value="' + esc(k) + '" ' + (meta.key === k ? 'selected' : '') + '>' + esc(m.label) + '</option>';
      }).join('') + '</select>' +
      (last ? '<div class="sub">' + esc(last.by) + ' · ' + esc(shortWhen(last.at)) + '</div>' : '');
  }
  function tieIn(t) {
    if (TimeOffCore.isExcused(t.status)) return 'Excused · 0 points';
    var meta = TimeOffCore.statusMeta(t.status);
    if (meta.key === 'Denied' || meta.key === 'Cancelled') return 'Points still apply';
    return 'Not yet excused';
  }
  function shortWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  // The whole trail, on hover. It is the thing an audit would ask for.
  function changeTitle(t) {
    return (t.statusHistory || []).map(function (e) {
      return shortWhen(e.at) + ' · ' + e.status + ' · ' + e.by + (e.note ? ' · ' + e.note : '');
    }).join('\n');
  }

  /* ---------- connecting an unmatched request ----------
     A request arrives with a name and no badge when the name was typed
     differently from the roster. Rather than guess, this searches the roster so
     a person picks. */
  /* Connecting a timeclock id to a profile. Separate from connectModal(), which
     patches a single record: this writes a mapping that every future on-premise
     upload consults, so the same person never has to be connected twice. */
  function linkModal(eid, name) {
    if (!eid) {
      alert('That row has no timeclock id, so there is nothing to connect. ' +
        'It has to be fixed in the on-premise report.');
      return;
    }
    state.connectFor = eid;
    state.connectKind = 'timeclock';
    state.connectQuery = name || '';
    document.body.insertAdjacentHTML('beforeend',
      '<div class="suite-modal-backdrop" id="suite-modal"><div class="suite-modal">' +
      '<div class="suite-modal-head"><h3>Connect “' + esc(name || eid) + '”</h3>' +
      '<button class="suite-btn" data-close>×</button></div>' +
      '<div class="connect-body">' +
      '<p class="perf-note">Timeclock id <b>' + esc(eid) + '</b> does not match any associate by name. ' +
      'Search the roster for the right person — the connection is remembered, so every future ' +
      'on-premise upload will find them.</p>' +
      '<input class="suite-input" id="connect-search" value="' + esc(state.connectQuery) +
      '" placeholder="Search by EID, name, or badge…" autofocus>' +
      '<div id="connect-results">' + connectResults() + '</div></div>' +
      '<div class="suite-modal-actions"><button type="button" class="suite-btn" data-close>Cancel</button></div>' +
      '</div></div>');
    var box = document.getElementById('connect-search');
    if (box) { box.focus(); box.select(); }
  }

  function connectModal(id, kind) {
    kind = kind || 'timeoff';
    var t = (state.stores[LOCAL_OF[kind]] || []).filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    state.connectFor = id;
    state.connectKind = kind;
    state.connectQuery = t.name || '';
    document.body.insertAdjacentHTML('beforeend',
      '<div class="suite-modal-backdrop" id="suite-modal"><div class="suite-modal">' +
      '<div class="suite-modal-head"><h3>Connect “' + esc(t.name || 'this request') + '”</h3>' +
      '<button class="suite-btn" data-close>×</button></div>' +
      '<div class="connect-body">' +
      '<p class="perf-note">Search the roster for the associate this request belongs to. ' +
      'Linking is recorded against your name.</p>' +
      '<input class="suite-input" id="connect-search" value="' + esc(state.connectQuery) +
      '" placeholder="Search by EID, name, or badge…" autofocus>' +
      '<div id="connect-results">' + connectResults() + '</div></div>' +
      '<div class="suite-modal-actions"><button type="button" class="suite-btn" data-close>Cancel</button></div>' +
      '</div></div>');
    var box = document.getElementById('connect-search');
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  }
  function connectResults() {
    var q = (state.connectQuery || '').trim().toLowerCase();
    if (!q) return '<div class="connect-hint">Type a name to search ' + state.profiles.size + ' associates.</div>';
    var hits = allProfiles().filter(function (p) {
      return searchText(p).toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return a.name.localeCompare(b.name); }).slice(0, 25);
    if (!hits.length) return '<div class="connect-hint">No associate matches “' + esc(q) + '”.</div>';
    return hits.map(function (p) {
      return '<button class="connect-hit" data-connect-to="' + esc(p.badge) + '">' +
        '<div class="initial">' + esc(p.initials) + '</div>' +
        '<div><div class="name">' + esc(p.name) + '</div>' +
        '<div class="sub">' + idLine(p) + ' · ' + esc(p.market) +
        (p.status === 'Ended' ? ' · <b class="warn-text">Ended</b>' : '') + '</div></div>' +
        '<span>›</span></button>';
    }).join('');
  }

  /* ---------- tasks ----------
     The queue of what is outstanding, wherever it was raised.

     Two sources feed it. Stored tasks are records of their own -- raised by
     hand, or dropped in by something that noticed work (marking somebody
     Terminated on the on-premise check). Derived tasks are pending PTO requests
     and open payroll discrepancies, projected into the task shape on read.

     Derived ones are deliberately not copied into the tasks collection: there
     would then be two records for one job, and marking one done would leave the
     other lying. They are read-only here and link to the page that owns them. */
  function storedTasks() {
    return (state.stores.tasks || []).map(TasksCore.normalize);
  }
  function derivedTasks() {
    return TasksCore.fromRecords(state.stores.timeOff || [], {
      kind: 'pto', sourceKind: 'timeoff', source: 'Time Off',
      needsAction: TimeOffCore.needsAction,
      titleOf: function (r) {
        return (r.type || 'Time off') + ' · ' + (r.name || r.badge || 'unknown') +
          (r.start ? ' · ' + r.start + (r.end && r.end !== r.start ? ' to ' + r.end : '') : '');
      },
      detailOf: function (r) { return r.notes || ''; },
      statusLabelOf: function (r) { return TimeOffCore.statusMeta(r.status).label; }
    }).concat(TasksCore.fromRecords(state.stores.discrepancies || [], {
      kind: 'payroll', sourceKind: 'discrepancies', source: 'Payroll',
      // Four hours, per the payroll rule -- not the 48 everything else gets.
      hours: TasksCore.kindMeta('payroll').hours,
      needsAction: PayrollCore.pipeline.needsAction,
      titleOf: function (r) {
        return 'Payroll · ' + (r.name || r.badge || 'unknown') +
          (r.weekEnding ? ' · week ending ' + r.weekEnding : '');
      },
      detailOf: function (r) { return r.details || ''; },
      statusLabelOf: function (r) { return PayrollCore.pipeline.statusMeta(r.status).label; }
    }));
  }
  // Every task, stored and derived, with the market filter applied.
  function allTasks() {
    return storedTasks().concat(derivedTasks()).filter(function (t) {
      // A task with no market is never hidden: it is usually the ones with no
      // profile attached that most need chasing.
      return state.market === 'all' || !t.market || t.market === state.market;
    });
  }
  function openTasks() { return allTasks().filter(TasksCore.isOpen); }

  function urgencyChip(t, now) {
    var u = TasksCore.urgencyOf(t, now);
    if (u === TasksCore.NONE) return '';
    var label = TasksCore.ageLabel(t, now);
    var cls = u === TasksCore.URGENT ? 'bad' : u === TasksCore.DUE ? 'warn' : '';
    return '<span class="task-age ' + cls + '">' +
      (u === TasksCore.URGENT ? 'Urgent · ' : '') + esc(label) + '</span>';
  }

  function tasksView() {
    if (!state.storesLoaded) return loadingPanel('tasks');
    var now = new Date();
    var every = allTasks();
    var sum = TasksCore.summarize(every, now);
    var showDone = state.tasks.showDone;
    var q = state.query.trim().toLowerCase();
    var rows = TasksCore.sort(every.filter(function (t) {
      if (!showDone && !TasksCore.isOpen(t)) return false;
      if (state.tasks.kind !== 'all' && TasksCore.kindMeta(t.kind).key !== state.tasks.kind) return false;
      if (!q) return true;
      return searchText(t.badge ? profile(t.badge) : null,
        t.title + ' ' + t.detail + ' ' + t.name + ' ' + t.badge).toLowerCase().indexOf(q) !== -1;
    }), now);

    return hero('Tasks', 'Everything outstanding, from wherever it was raised. A task stays until somebody marks it complete.') +
      '<div class="metric-strip">' +
      metric('Urgent', sum.urgent, 'Past the time they should have moved', sum.urgent ? 'orange' : 'green') +
      metric('Due soon', sum.due, 'In the last quarter of their window') +
      metric('Open', sum.open, 'Not yet complete') +
      metric('Completed', sum.complete, 'Still on file') +
      '</div>' +
      (sum.urgent ? '<div class="warn-banner"><b>' + sum.urgent + '</b> task' +
        (sum.urgent === 1 ? ' has' : 's have') + ' gone past the window. Payroll issues escalate after ' +
        TasksCore.kindMeta('payroll').hours + ' hours, everything else after ' +
        TasksCore.kindMeta('note').hours + '.</div>' : '') +
      '<section class="suite-panel">' +
      '<div class="filter-row"><input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="Search by EID, title, detail, or name…">' +
      '<select class="suite-select" id="task-kind"><option value="all">All kinds</option>' +
      TasksCore.KINDS.map(function (k) {
        return '<option value="' + esc(k.key) + '" ' + (state.tasks.kind === k.key ? 'selected' : '') +
          '>' + esc(k.label) + ' (' + (sum.byKind[k.key] || 0) + ')</option>';
      }).join('') + '</select>' +
      '<label class="cov-ctl"><input type="checkbox" id="task-done"' + (showDone ? ' checked' : '') +
      '> <span>Show completed</span></label></div>' +
      (rows.length ? '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
        '<th>Task</th><th>Kind</th><th>Associate</th><th>Raised</th><th>Age</th><th>Status</th><th></th>' +
        '</tr></thead><tbody>' +
        rows.slice(0, MAX_ROWS).map(function (t) { return taskRow(t, now); }).join('') +
        '</tbody></table></div>' + rowCap(Math.min(rows.length, MAX_ROWS), rows.length)
        : empty(showDone ? 'Nothing matches those filters' : 'Nothing outstanding',
            'Raise one with the + button in the top bar, or widen the filters.')) +
      '</section>';
  }

  function taskRow(t, now) {
    var u = TasksCore.urgencyOf(t, now);
    var p = t.badge ? profile(t.badge) : null;
    var kind = TasksCore.kindMeta(t.kind);
    return '<tr class="' + (u === TasksCore.URGENT ? 'cov-row bad' : u === TasksCore.DUE ? 'cov-row warn' : '') + '">' +
      '<td class="detail-cell"><div class="name">' + esc(t.title) + '</div>' +
      (t.detail ? '<div class="sub">' + esc(t.detail) + '</div>' : '') + '</td>' +
      '<td><span class="task-kind">' + esc(kind.label) + '</span>' +
      (kind.unknown ? '<div class="sub warn-text">not a kind this build knows</div>' : '') + '</td>' +
      '<td>' + (p ? '<div class="name link" data-profile="' + esc(p.badge) + '">' + esc(p.name) + '</div>' +
                    '<div class="sub">' + idLine(p) + '</div>'
                  : t.name ? '<div class="name">' + esc(t.name) + '</div>' +
                    '<div class="sub warn-text">no profile</div>'
                  : '<span class="sub">—</span>') + '</td>' +
      '<td>' + esc(shortWhen(t.createdAt) || '—') + '<div class="sub">' + esc(t.source || '') + '</div></td>' +
      '<td>' + urgencyChip(t, now) + '</td>' +
      /* A derived task is a view of a record that lives elsewhere, so its status
         is shown, not offered: changing it belongs on the page that owns it. */
      '<td>' + (t.derived
        ? '<span class="cov-status">' + esc(t.statusLabel || t.status) + '</span>' +
          '<div class="sub">on ' + esc(TasksCore.kindMeta(t.kind).panel === 'timeoff' ? 'Time Off' : 'Payroll') + '</div>'
        : pipelineSelect(t, TasksCore.pipeline, 'tasks')) + '</td>' +
      '<td>' + (t.derived
        ? '<button class="suite-btn" data-nav="' + esc(kind.panel) + '">Open ›</button>'
        : '<button class="suite-btn" data-task-done="' + esc(t.id) + '"' +
          (TasksCore.isOpen(t) ? '' : ' disabled') + '>Complete</button> ' +
          '<button class="suite-btn danger" data-del="tasks|' + esc(t.id) + '">Remove</button>') +
      '</td></tr>';
  }

  /* ---------- payroll ----------
     Two things that are really one thing: hours moving after somebody thought
     they were final. The discrepancy form is the team reporting it; the Beeline
     hours watch is the system noticing it. */
  function payrollView() {
    var pr = state.payroll;
    return hero('Payroll', 'Discrepancies raised by the team, and hours that changed after a period closed.', '', '') +
      '<div class="filter-row payroll-tabs">' +
      [['discrepancies', 'Discrepancies'], ['hours', 'Beeline hours']].map(function (x) {
        return '<button class="suite-btn ' + (pr.tab === x[0] ? 'primary' : '') +
          '" data-payroll-tab="' + x[0] + '">' + esc(x[1]) + '</button>';
      }).join('') + '</div>' +
      (pr.tab === 'hours' ? payrollHours() : payrollDiscrepancies());
  }

  function payrollDiscrepancies() {
    if (!state.storesLoaded) return loadingPanel('discrepancies');
    var q = state.query.trim().toLowerCase();
    var all = (state.stores.discrepancies || []).filter(function (dsc) {
      var p = profile(dsc.badge);
      if (p ? !inMarket(p) : state.market !== 'all' && dsc.badge) return false;
      if (!q) return true;
      return searchText(p, (p ? '' : dsc.name || '') + ' ' + dsc.badge + ' ' + dsc.location + ' ' +
        dsc.details + ' ' + dsc.status).toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
    var rows = all.slice(0, MAX_ROWS);
    var open = all.filter(function (dsc) { return PayrollCore.pipeline.needsAction(dsc.status); }).length;
    var orphans = (state.stores.discrepancies || []).filter(function (dsc) { return !profile(dsc.badge); });

    return '<div class="metric-strip">' +
      metric('Open discrepancies', open, 'Not yet corrected or closed', open ? 'orange' : 'green') +
      metric('Total raised', all.length, 'In this market') +
      metric('Unmatched', orphans.length, 'Need connecting to an associate', orphans.length ? 'orange' : 'green') +
      '</div>' +
      (orphans.length ? '<div class="warn-banner"><b>' + orphans.length + '</b> discrepanc' +
        (orphans.length === 1 ? 'y' : 'ies') + ' could not be matched to an associate — usually a name ' +
        'typed differently on the form. Use Connect to link them.</div>' : '') +
      '<section class="suite-panel">' +
      '<div class="filter-row"><input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="Search by EID, name, location, detail, or status…"></div>' +
      (rows.length ? '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
        '<th>Associate</th><th>Location</th><th>Date</th><th>Week ending</th><th>Details</th>' +
        '<th>Status</th><th></th></tr></thead><tbody>' +
        rows.map(function (dsc) {
          var p = profile(dsc.badge);
          return '<tr' + (p ? '' : ' class="cov-row warn"') + '><td>' +
            (p ? '<div class="name link" data-profile="' + esc(p.badge) + '">' + esc(p.name) + '</div>' +
                 '<div class="sub">' + idLine(p) + '</div>'
               : '<div class="name">' + esc(dsc.name || 'Unknown') + '</div>' +
                 '<div class="sub warn-text">Not matched to a profile</div>') + '</td>' +
            '<td>' + esc(dsc.location || '—') + '</td>' +
            '<td>' + esc(dsc.date || '<span class="warn-text">not set</span>') + '</td>' +
            '<td>' + esc(dsc.weekEnding || '—') + '</td>' +
            '<td class="detail-cell">' + esc(dsc.details || '') + '</td>' +
            '<td>' + pipelineSelect(dsc, PayrollCore.pipeline, 'discrepancies') + '</td>' +
            '<td>' + (p ? '' : '<button class="suite-btn" data-connect="' + esc(dsc.id) +
              '" data-connect-kind="discrepancies">Connect…</button> ') +
            '<button class="suite-btn danger" data-del="discrepancies|' + esc(dsc.id) + '">Remove</button></td></tr>';
        }).join('') + '</tbody></table></div>' + rowCap(rows.length, all.length)
        : empty('No discrepancies yet', 'They arrive from the GEODIS Payroll Discrepancy Form.')) +
      '</section>';
  }

  /* Hours pulled from Beeline, period by period. The interesting number is what
     moved AFTER the period closed -- money already out the door being changed
     behind it. Nothing is flagged until a close time has been recorded, because
     a guessed cutoff would either cry wolf or stay silent. */
  function payrollHours() {
    var pr = state.payroll;
    var picker = '<div class="filter-row cov-controls">' +
      '<label class="cov-ctl">Pay period<select class="suite-select" id="payroll-week">' +
      (pr.periods.length
        ? pr.periods.slice().sort().reverse().map(function (w) {
            return '<option value="' + esc(w) + '" ' + (pr.week === w ? 'selected' : '') + '>' +
              'Week ending ' + esc(w) + '</option>';
          }).join('')
        : '<option value="">No periods yet</option>') +
      '</select></label>' +
      (pr.week ? '<label class="cov-ctl">Payroll closed<input class="suite-input" type="datetime-local" ' +
        'id="payroll-close" value="' + esc(dtValue(closeDate())) + '"></label>' +
        '<span class="cov-asof-note">' + (pr.period && pr.period.closesAt
          ? 'Changes after this are flagged' : 'Set this to flag post-close changes') + '</span>' : '') +
      '</div>';

    if (pr.loading) return picker + loadingPanel('this pay period');
    if (!pr.periods.length) {
      return picker + '<section class="suite-panel"><div class="workflow-empty">' +
        'No hours have been posted yet. An automation posts each pull of the Beeline hours report to ' +
        '<code>?payroll=1&amp;week=YYYY-MM-DD</code>, and every pull after the first is compared with the one ' +
        'before it.</div></section>';
    }
    var period = pr.period || {};
    var snaps = period.snapshots || [];
    var changes = (period.changes || []).slice().reverse();
    var afterClose = changes.filter(function (c) { return c.afterClose; });
    var latest = snaps.length ? snaps[snaps.length - 1] : null;
    var sum = (latest && latest.summary) || {};

    return picker +
      '<div class="metric-strip">' +
      metric('Changed after close', afterClose.length, period.closesAt ? 'Since ' + esc(shortWhen(period.closesAt)) : 'No close date set',
        afterClose.length ? 'orange' : 'green') +
      metric('Hours on file', sum.totalHours == null ? '—' : sum.totalHours, (sum.people || 0) + ' associates') +
      metric('Changes this period', (period.changes || []).length, 'Across ' + snaps.length + ' pull' + (snaps.length === 1 ? '' : 's')) +
      metric('Net hours moved', sum.net == null ? '—' : (sum.net > 0 ? '+' : '') + sum.net, 'Latest pull vs the one before') +
      '</div>' +
      (afterClose.length ? '<div class="warn-banner"><b>' + afterClose.length + '</b> hour change' +
        (afterClose.length === 1 ? '' : 's') + ' landed after this period closed. Those are the ones to check ' +
        'against what was already paid.</div>' : '') +
      '<section class="suite-panel"><div class="suite-panel-head"><h2>Hour changes</h2></div>' +
      (changes.length ? '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
        '<th>Associate</th><th>Change</th><th>Before</th><th>After</th><th>Delta</th><th>Seen</th></tr></thead><tbody>' +
        changes.slice(0, MAX_ROWS).map(function (c) {
          var p = profile(c.badge);
          return '<tr class="' + (c.afterClose ? 'cov-row bad' : '') + '"><td>' +
            (p ? '<div class="name link" data-profile="' + esc(p.badge) + '">' + esc(p.name) + '</div>'
               : '<div class="name">' + esc(c.name || c.badge) + '</div>') +
            '<div class="sub">' + (idLine(profile(c.badge)) || esc(c.badge)) + '</div></td>' +
            '<td><span class="cov-status ' + (c.kind === 'removed' ? 'bad' : c.kind === 'added' ? 'warn' : '') + '">' +
            esc(c.kind) + '</span>' + (c.afterClose ? '<span class="cov-flag bad">after close</span>' : '') + '</td>' +
            '<td>' + esc(c.from) + '</td><td>' + esc(c.to) + '</td>' +
            '<td class="' + (c.delta > 0 ? 'delta-up' : c.delta < 0 ? 'delta-down' : '') + '">' +
            (c.delta > 0 ? '+' : '') + esc(c.delta) + '</td>' +
            '<td>' + esc(shortWhen(c.at)) + '</td></tr>';
        }).join('') + '</tbody></table></div>' + rowCap(Math.min(changes.length, MAX_ROWS), changes.length)
        : empty('No changes recorded', snaps.length < 2
            ? 'The first pull is a baseline. Changes appear from the second pull onward.'
            : 'Hours have not moved since the first pull.')) +
      '</section>';
  }
  function closeDate() {
    var c = state.payroll.period && state.payroll.period.closesAt;
    var d = c ? new Date(c) : null;
    return d && !isNaN(d.getTime()) ? d : new Date();
  }

  /* One status dropdown, driven by whichever pipeline the record belongs to. */
  function pipelineSelect(rec, pipe, collection) {
    var meta = pipe.statusMeta(rec.status);
    var keys = pipe.STATUS_KEYS.slice();
    if (meta.unknown) keys.unshift(meta.key);
    var last = pipe.lastChange(rec);
    return '<select class="suite-select status-select ' + esc(meta.cls) + '" data-status="' + esc(rec.id) +
      '" data-status-kind="' + esc(collection) + '"' +
      (last ? ' title="' + esc(changeTitle(rec)) + '"' : '') + '>' +
      keys.map(function (k) {
        return '<option value="' + esc(k) + '" ' + (meta.key === k ? 'selected' : '') + '>' +
          esc(pipe.statusMeta(k).label) + '</option>';
      }).join('') + '</select>' +
      (last ? '<div class="sub">' + esc(last.by) + ' · ' + esc(shortWhen(last.at)) + '</div>' : '');
  }

  /* ---------- settings ----------
     Accounts, locations and shifts. Sign-in is not enforced yet, so this page is
     reachable by anyone today; once it is, everything here needs the admin role.
     The page says so rather than pretending to be locked. */
  function settingsView() {
    var a = state.auth;
    var admin = a.account && AuthCore.isAdmin(a.account);
    var tabs = [['account', 'Account'], ['users', 'Users'], ['locations', 'Locations'],
      ['shifts', 'Shifts'], ['connections', 'Connections'], ['links', 'RC links']];
    if (!state.admin.loaded && state.admin.tab !== 'account') loadAdminData();
    return hero('Settings', 'Accounts, roles, locations and shifts.', '', '') +
      (a.signedIn && !admin
        ? '<div class="warn-banner">You are signed in as <b>' + esc(a.email) + '</b> with the ' +
          esc(AuthCore.roleMeta(a.account && a.account.role).label) + ' role. Changing accounts, ' +
          'locations or shifts needs an administrator.</div>'
        : '') +
      '<div class="filter-row payroll-tabs">' + tabs.map(function (x) {
        return '<button class="suite-btn ' + (state.admin.tab === x[0] ? 'primary' : '') +
          '" data-settings-tab="' + x[0] + '">' + esc(x[1]) + '</button>';
      }).join('') + '</div>' +
      (state.admin.tab === 'account' ? accountPanel()
        : !state.admin.loaded ? loadingPanel('settings')
        : state.admin.tab === 'users' ? usersPanel(admin)
        : state.admin.tab === 'locations' ? listPanel('locations', admin)
        : state.admin.tab === 'connections' ? connectionsPanel()
        : state.admin.tab === 'links' ? appConfigPanel(admin)
        : listPanel('shiftTypes', admin));
  }

  /* ---------- connections ----------
     The one-time job. The workbook knows every associate's EID and the roster
     knows every associate's badge, and nothing knows both -- so a profile only
     learns its EID when the two systems happen to spell the name the same way.
     Where they do not, that person is invisible to attendance, points and time
     off, and no amount of re-uploading will fix it.

     A connection made here is stored against the EID and outlives every upload,
     so this list is worked once and then only when somebody new starts. */
  function connectionData() {
    return ShiftKey.connectionReview({
      shifts: state.stores.shifts,
      profiles: allProfiles(),
      // A profile holds one timeclock id; the links hold every one somebody has
      // connected. Without them a person with two ids never leaves this list.
      links: state.stores.timeclockLinks,
      similarity: ReconcileCore.nameSimilarity
    });
  }

  // Confident enough to offer as a single click. Below this the suggestion is
  // still shown, but the button says "Review" and opens the search instead.
  var CONNECT_CONFIDENT = 0.88;

  function connectionsPanel() {
    var rev = connectionData();
    var s = rev.summary;
    var q = state.query.trim().toLowerCase();
    var rows = rev.unconnected.filter(function (u) {
      if (!q) return true;
      return (u.name + ' ' + u.eid + ' ' + u.building + ' ' +
        u.suggestions.map(function (x) { return x.name; }).join(' ')).toLowerCase().indexOf(q) !== -1;
    });

    if (!state.stores.shifts.length) {
      /* Nothing to review without the workbook -- but connections already made are
         still shown, and still undoable. Hiding them behind an import meant a
         connection made in one session could not be corrected in the next. */
      return '<section class="suite-panel"><div class="workflow-empty">' +
        'No PLX workbook roster has been imported yet, so there is nothing to connect. ' +
        'Import it from the Associates tab first.</div></section>' + connectedPanel();
    }

    return '<div class="metric-strip">' +
      metric('Connected', s.connected, 'of ' + s.total + ' on the workbook roster',
        s.connected === s.total ? 'green' : '') +
      metric('Not connected', s.unconnected, 'Invisible to attendance and points',
        s.unconnected ? 'orange' : 'green') +
      metric('Ready to connect', s.withSuggestion, 'A close name is waiting on one click') +
      metric('Need a decision', s.contested + s.noMatch,
        s.contested + ' contested · ' + s.noMatch + ' with no near match') +
      '</div>' +
      (s.noEid ? '<div class="warn-banner"><b>' + s.noEid + '</b> workbook row(s) have no EID at all, ' +
        'so they cannot be connected this way — fix the EID column in the workbook.</div>' : '') +
      multiLinkNote(rev) +
      '<section class="suite-panel">' +
      '<div class="suite-panel-head"><h2>Workbook roster not connected to a profile</h2></div>' +
      '<p class="perf-note">The workbook spells a name one way and the roster another, so these people ' +
      'never join up. Connecting one is remembered against the timeclock id and survives every future ' +
      'upload. <b>Check the suggestion before accepting it</b> — a close score is a reason to look, not a ' +
      'decision, and a wrong connection files one person’s attendance against another.</p>' +
      '<div class="filter-row"><input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="Search by name, timeclock id, or building…"></div>' +
      (rows.length ? connectionTable(rows)
        : empty(s.unconnected ? 'Nothing matches that search' : 'Everyone on the workbook roster is connected',
          s.unconnected ? 'Clear the search to see the rest.'
            : 'New starters will appear here when the workbook next names somebody the roster spells differently.')) +
      '</section>' + connectedPanel();
  }

  /* People carrying more than one timeclock id. Often legitimate -- the same
     associate under two agencies, 80- for one and 87- for the other -- but it is
     also exactly what a mistyped id in the workbook looks like, and the two are
     told apart by reading the ids, not by a rule. Worth showing either way: the
     mistyped case means somebody else's id is sitting on this person's row. */
  function multiLinkNote(rev) {
    var rows = rev.multiLinked || [];
    if (!rows.length) return '';
    return '<div class="warn-banner"><strong>' + rows.length +
      ' associate(s) are connected to more than one timeclock id</strong>' +
      '<p>Two ids for one person is normal where they work under two agencies. Where the ids do not ' +
      'look like the same person, the workbook has somebody else’s id on their row — fix it at source, ' +
      'because every report keyed on that id is being attributed to the wrong person.</p>' +
      '<ul>' + rows.slice(0, 10).map(function (m) {
        return '<li><b>' + esc(m.name || m.badge) + '</b> — ' +
          m.eids.map(function (e) {
            return '<span class="mono">' + esc(e) + '</span> ' +
              '<button class="suite-btn tiny danger" data-disconnect="TCL-' +
              esc(String(e).replace(/[^A-Za-z0-9_-]/g, '')) + '">Disconnect</button>';
          }).join(' &nbsp; ') + '</li>';
      }).join('') + (rows.length > 10 ? '<li>…and ' + (rows.length - 10) + ' more.</li>' : '') +
      '</ul></div>';
  }

  function connectionTable(rows) {
    return '<div class="suite-table-wrap"><table class="suite-table connect-pending"><thead><tr>' +
      '<th>On the workbook</th><th>Timeclock id</th><th>Site / shift</th>' +
      '<th>Closest roster match</th><th></th></tr></thead><tbody>' +
      rows.slice(0, MAX_ROWS).map(function (u) {
        var top = u.suggestions[0];
        var confident = top && top.score >= CONNECT_CONFIDENT && !u.contested;
        return '<tr class="' + (u.contested ? 'cov-row warn' : '') + '">' +
          '<td><div class="name">' + esc(u.name) + '</div>' +
          (u.dept ? '<div class="sub">' + esc(u.dept) + '</div>' : '') + '</td>' +
          '<td class="mono">' + esc(u.eid) + '</td>' +
          '<td>' + esc(u.building || '—') + (u.shift ? ' · ' + esc(u.shift) : '') + '</td>' +
          '<td>' + (top
            ? '<div class="name">' + esc(top.name) + '</div><div class="sub">' +
              (top.empNumber ? 'EID ' + esc(top.empNumber) + ' · ' : '') +
              '<b class="' + (confident ? 'ok-text' : 'warn-text') + '">' +
              Math.round(top.score * 100) + '% name match</b>' +
              (u.contested ? ' · <span class="warn-text">another row wants this person too</span>' : '') +
              '</div>'
            : '<span class="score none">No near match on the roster</span>') + '</td>' +
          '<td>' + (confident
            ? '<button class="suite-btn primary" data-connect-accept="' + esc(u.eid) +
              '|' + esc(top.badge) + '|' + esc(u.name) + '">Connect</button>'
            : '<button class="suite-btn" data-link-eid="' + esc(u.eid) +
              '" data-link-name="' + esc(u.name) + '">Review…</button>') + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>' + rowCap(Math.min(rows.length, MAX_ROWS), rows.length);
  }

  /* ---------- undoing a connection ----------
     A connection is a decision somebody made, and decisions are sometimes wrong:
     the workbook can carry another person's timeclock id, and connecting it files
     that id against the wrong associate. Until now there was no way back.

     Disconnecting does NOT fix the workbook. If the row there still carries the
     wrong id, that person returns to the unconnected list on the next look --
     which is right: the tool should keep asking until the source is corrected. */
  function connectedList() {
    var links = state.stores.timeclockLinks || [];
    var perBadge = {};
    links.forEach(function (l) { perBadge[l.badge] = (perBadge[l.badge] || 0) + 1; });
    var q = state.query.trim().toLowerCase();
    return links.map(function (l) {
      var p = profile(l.badge);
      return {
        id: l.id, eid: l.eid, badge: l.badge,
        rosterName: l.rosterName || (p ? p.name : ''),
        workbookName: l.name || '',
        linkedBy: l.linkedBy || '', linkedAt: l.linkedAt || '',
        onRoster: !!p,
        alsoLinked: perBadge[l.badge] > 1
      };
    }).filter(function (r) {
      if (!q) return true;
      return (r.eid + ' ' + r.rosterName + ' ' + r.workbookName + ' ' + r.badge + ' ' + r.linkedBy)
        .toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) {
      // The ones worth reviewing first: a person with two ids, then anyone whose
      // profile has left the roster, then by name.
      return (b.alsoLinked - a.alsoLinked) || (a.onRoster - b.onRoster) ||
        String(a.rosterName).localeCompare(String(b.rosterName));
    });
  }

  function connectedPanel() {
    var rows = connectedList();
    if (!(state.stores.timeclockLinks || []).length) return '';
    return '<section class="suite-panel"><div class="suite-panel-head">' +
      '<h2>Connected by hand</h2></div>' +
      '<p class="perf-note">Every connection somebody made, newest concerns first. Disconnecting one puts ' +
      'that associate back on the list above — it does not change the workbook, so if the row there still ' +
      'carries the wrong id, they will keep reappearing until it is corrected at source.</p>' +
      (rows.length
        ? '<div class="suite-table-wrap"><table class="suite-table connect-made"><thead><tr>' +
          '<th>Timeclock id</th><th>Connected to</th><th>On the workbook as</th><th>By</th><th></th>' +
          '</tr></thead><tbody>' +
          rows.slice(0, MAX_ROWS).map(function (r) {
            return '<tr class="' + (r.alsoLinked ? 'cov-row warn' : '') + '">' +
              '<td class="mono">' + esc(r.eid) + '</td>' +
              '<td><div class="' + (r.onRoster ? 'name link' : 'name') + '"' +
              (r.onRoster ? ' data-profile="' + esc(r.badge) + '"' : '') + '>' +
              esc(r.rosterName || r.badge) + '</div>' +
              '<div class="sub">' + (r.onRoster ? 'Badge ' + esc(r.badge)
                : '<b class="warn-text">no longer on the roster</b>') +
              (r.alsoLinked ? ' · <span class="warn-text">also linked to another id</span>' : '') +
              '</div></td>' +
              '<td>' + esc(r.workbookName || '—') + '</td>' +
              '<td>' + esc(r.linkedBy || '—') +
              (r.linkedAt ? '<div class="sub">' + esc(String(r.linkedAt).slice(0, 10)) + '</div>' : '') + '</td>' +
              '<td><button class="suite-btn danger" data-disconnect="' + esc(r.id) + '">Disconnect</button></td>' +
              '</tr>';
          }).join('') + '</tbody></table></div>' + rowCap(Math.min(rows.length, MAX_ROWS), rows.length)
        : empty('Nothing matches that search', 'Clear the search to see every connection.')) +
      '</section>';
  }

  function disconnect(id) {
    var rec = (state.stores.timeclockLinks || []).filter(function (x) { return x.id === id; })[0];
    if (!rec) return;
    var who = rec.rosterName || rec.badge;
    if (!confirm('Disconnect ' + rec.eid + ' from ' + who + '?\n\n' +
      'Anything that reaches ' + who + ' through that timeclock id — attendance, points, ' +
      'time off — stops doing so.\n\n' +
      'This does not change the PLX workbook. If the row there still carries this id, ' +
      'they will appear on the unconnected list again.')) return;
    SuiteData.deleteRecord('timeclockLinks', id).then(function () {
      return SuiteData.loadCollection('timeclockLinks');
    }).then(function (rows) {
      state.stores.timeclockLinks = rows;
      rebuild();
      render();
    }).catch(function (err) {
      alert('That connection could not be removed.\n\n' + err.message);
    });
  }

  /* Accepting a suggestion writes the same record the search modal writes, so
     there is one shape of connection however it was made. */
  function acceptConnection(eid, badge, workbookName) {
    var actor = currentActor(true);
    if (!actor) return;
    var target = profile(badge);
    if (!target) { alert('That associate is no longer on the roster.'); return; }
    SuiteData.saveRecord('timeclockLinks', {
      id: 'TCL-' + eid.replace(/[^A-Za-z0-9_-]/g, ''),
      eid: eid, badge: badge,
      name: workbookName, rosterName: target.name,
      linkedBy: actor.name, linkedAt: new Date().toISOString()
    }).then(function () {
      return SuiteData.loadCollection('timeclockLinks');
    }).then(function (rows) {
      state.stores.timeclockLinks = rows;
      rebuild();
      render();
    }).catch(function (err) {
      alert('That connection could not be saved.\n\n' + err.message);
    });
  }

  function accountPanel() {
    var a = state.auth;
    if (a.signedIn) {
      var role = AuthCore.roleMeta(a.account && a.account.role);
      var mk = (a.account && a.account.markets) || [];
      return '<section class="suite-panel"><div class="suite-panel-head"><h2>Signed in</h2>' +
        '<div class="suite-actions"><button class="suite-btn" data-sign-out>Sign out</button></div></div>' +
        '<dl class="detail-list">' +
        detail('Email', a.email) +
        detail('Role', role.label + (role.unknown ? ' — not a role this build knows, so it grants nothing' : '')) +
        detail('Markets', mk.length ? mk.join(', ') : 'All markets') +
        detail('Account', a.account && a.account.enabled === false ? 'Disabled' : 'Active') +
        '</dl>' +
        (a.error ? '<div class="warn-banner">' + esc(a.error) + '</div>' : '') +
        '<p class="perf-note">Sign-in is not enforced yet, so the tool works signed out exactly as it ' +
        'did before. What signing in changes today is that status changes are attributed to your ' +
        'account rather than a name typed into this browser.</p></section>';
    }
    return '<section class="suite-panel"><div class="suite-panel-head"><h2>Sign in</h2></div>' +
      '<form class="signin-form" data-signin>' +
      '<label class="suite-field"><span>Work email</span>' +
      '<input name="email" type="email" autocomplete="username" placeholder="you@geodis.com" required></label>' +
      '<label class="suite-field"><span>Password</span>' +
      '<input name="password" type="password" autocomplete="current-password" minlength="6" required></label>' +
      '<div class="signin-actions">' +
      '<button class="suite-btn primary" data-signin-do="in"' + (a.loading ? ' disabled' : '') + '>' +
      (a.loading ? 'Working…' : 'Sign in') + '</button>' +
      '<button type="button" class="suite-btn" data-signin-do="create">Create account</button>' +
      '<button type="button" class="suite-btn" data-signin-do="reset">Forgot password</button>' +
      '</div></form>' +
      (a.error ? '<div class="warn-banner">' + esc(a.error) + '</div>' : '') +
      '<p class="perf-note">Open to <b>' + esc(AuthCore.ALLOWED_DOMAINS.join('</b> and <b>')) + '</b> ' +
      'addresses. A new account starts as a viewer until an administrator changes it.</p></section>';
  }

  function usersPanel(admin) {
    var rows = state.admin.users.map(AuthCore.normalizeUser)
      .sort(function (x, y) { return x.email.localeCompare(y.email); });
    var me = state.auth.account;
    var markets = allMarkets();
    return '<section class="suite-panel">' +
      (rows.length ? '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
        '<th>Email</th><th>Name</th><th>Role</th><th>Markets</th><th>Status</th><th>Last seen</th></tr></thead><tbody>' +
        rows.map(function (u) {
          // An admin cannot edit their own access, so the row is shown read-only
          // rather than offering a control that would be refused.
          var editable = admin && AuthCore.canManage(me, u);
          return '<tr><td><div class="name">' + esc(u.email) + '</div>' +
            (me && me.email === u.email ? '<div class="sub">This is you</div>' : '') + '</td>' +
            '<td>' + esc(u.name || '—') + '</td>' +
            '<td>' + (editable
              ? '<select class="suite-select" data-user-role="' + esc(u.email) + '">' +
                AuthCore.grantableRoles(me).map(function (k) {
                  return '<option value="' + esc(k) + '" ' + (u.role === k ? 'selected' : '') + '>' +
                    esc(AuthCore.roleMeta(k).label) + '</option>';
                }).join('') + '</select>'
              : esc(AuthCore.roleMeta(u.role).label)) + '</td>' +
            '<td>' + (editable
              ? '<input class="suite-input" data-user-markets="' + esc(u.email) + '" value="' +
                esc(u.markets.join(', ')) + '" placeholder="All markets">' +
                '<div class="sub">' + esc(markets.join(', ') || 'no markets yet') + '</div>'
              : esc(u.markets.length ? u.markets.join(', ') : 'All markets')) + '</td>' +
            '<td>' + (editable
              ? '<button class="suite-btn ' + (u.enabled ? 'danger' : '') + '" data-user-toggle="' + esc(u.email) + '">' +
                (u.enabled ? 'Disable' : 'Enable') + '</button>'
              : '<span class="status ' + (u.enabled ? '' : 'closed') + '">' + (u.enabled ? 'Active' : 'Disabled') + '</span>') + '</td>' +
            '<td>' + esc(u.lastSeenAt ? shortWhen(u.lastSeenAt) : 'never') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : empty('No accounts yet', 'Accounts appear here the first time someone signs in.')) +
      '</section>';
  }

  /* Locations and shifts are the same shape -- a short list an admin maintains --
     so they share a panel rather than two near-identical copies. */
  var LISTS = {
    locations: {
      title: 'Locations', add: 'Add location',
      cols: [['code', 'Site number'], ['name', 'Name'], ['market', 'Market']],
      blank: function () { return { code: '', name: '', market: '', active: true }; }
    },
    shiftTypes: {
      title: 'Shifts', add: 'Add shift',
      cols: [['key', 'Shift'], ['label', 'Label'], ['location', 'Site'], ['hours', 'Hours']],
      blank: function () { return { key: '', label: '', location: '', hours: '', active: true }; }
    }
  };
  /* The RC base URL and assignment object live in Settings rather than in code:
     they differ per Salesforce org, and a wrong URL should be a field to fix,
     not a deploy. */
  var APP_SETTINGS = [
    { key: 'rcBaseUrl', label: 'RC (Salesforce) base URL',
      hint: 'e.g. https://employbridge.lightning.force.com — a my.salesforce.com host works too. Blank shows no links.' },
    { key: 'rcAssignmentObject', label: 'RC assignment object API name',
      hint: 'The object an assignment record lives on. TargetRecruit uses TR1__Closing_Report__c; its ids start "a58".' },
    { key: 'ilPtoTrackerUrl', label: 'Shared IL PTO tracker (SharePoint)',
      hint: 'The workbook Chicago and St. Louis share. Adds an "Open the spreadsheet" link beside the PTO import.' }
  ];
  function appConfigPanel(admin) {
    var rows = state.admin.appConfig || [];
    var valueOf = function (k) {
      var r = rows.filter(function (x) { return x.key === k; })[0];
      return r ? r.value || '' : '';
    };
    return '<section class="suite-panel"><div class="suite-panel-head"><h2>RC links</h2></div>' +
      '<p class="perf-note">The daily RC assignment export carries an 18-character record id for the ' +
      'associate and the assignment. With a base URL set, those become links straight into RC.</p>' +
      APP_SETTINGS.map(function (f) {
        return '<label class="suite-field"><span>' + esc(f.label) + '</span>' +
          (admin
            ? '<input class="suite-input" data-app-config="' + f.key + '" value="' + esc(valueOf(f.key)) +
              '" placeholder="' + esc(f.hint) + '">'
            : '<span class="sub">' + esc(valueOf(f.key) || 'not set') + '</span>') +
          '<span class="sub">' + esc(f.hint) + '</span></label>';
      }).join('') +
      (valueOf('rcBaseUrl')
        ? '<p class="perf-note">Links are live, and show only where RC actually has a record id.</p>'
        : '<p class="perf-note">No base URL set, so no links appear anywhere — the ids are stored either way.</p>') +
      '</section>';
  }

  function listPanel(which, admin) {
    var spec = LISTS[which];
    var rows = (state.admin[which] || []).slice();
    return '<section class="suite-panel"><div class="suite-panel-head"><h2>' + esc(spec.title) + '</h2>' +
      (admin ? '<div class="suite-actions"><button class="suite-btn primary" data-list-add="' + which +
        '">+ ' + esc(spec.add) + '</button></div>' : '') + '</div>' +
      '<p class="perf-note">These supplement what the PLX workbook already provides — the Geodis Key ' +
      'supplies the shifts each building runs, and the HC tabs supply each associate’s. Add here only ' +
      'what the workbook does not cover.</p>' +
      (rows.length ? '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
        spec.cols.map(function (c) { return '<th>' + esc(c[1]) + '</th>'; }).join('') +
        '<th>Status</th>' + (admin ? '<th></th>' : '') + '</tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr>' + spec.cols.map(function (c) {
            return '<td>' + (admin
              ? '<input class="suite-input" data-list-field="' + which + '|' + esc(r.id) + '|' + c[0] +
                '" value="' + esc(r[c[0]] || '') + '">'
              : esc(r[c[0]] || '—')) + '</td>';
          }).join('') +
            '<td><span class="status ' + (r.active === false ? 'closed' : '') + '">' +
            (r.active === false ? 'Inactive' : 'Active') + '</span></td>' +
            (admin ? '<td><button class="suite-btn" data-list-toggle="' + which + '|' + esc(r.id) + '">' +
              (r.active === false ? 'Activate' : 'Deactivate') + '</button> ' +
              '<button class="suite-btn danger" data-del="' + which + '|' + esc(r.id) + '">Remove</button></td>' : '') +
            '</tr>';
        }).join('') + '</tbody></table></div>'
        : empty('Nothing added yet', admin ? 'Use ' + spec.add + ' above.' : 'An administrator can add these.')) +
      '</section>';
  }
  function allMarkets() { return markets(); }

  function loadAdminData() {
    if (state.admin.loading) return;
    state.admin.loading = true;
    SuiteData.loadAdmin().then(function (d) {
      state.admin.users = d.users;
      state.admin.locations = d.locations;
      state.admin.shiftTypes = d.shiftTypes;
      state.admin.appConfig = d.appConfig;
      // The link helpers read from stores, so keep the two in step after an edit.
      state.stores.appConfig = d.appConfig;
      state.admin.loaded = true;
      state.admin.loading = false;
      render();
    });
  }

  /* ---------- requisitions ---------- */
  function reqTable(rows, compact) {
    return '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
      '<th>Requisition</th><th>Department</th><th>Shift</th><th>Positions</th><th>Filled</th><th>Coverage</th>' +
      (compact ? '' : '<th>Priority</th><th>Status</th><th></th>') + '</tr></thead><tbody>' +
      rows.map(function (r) {
        var openings = Number(r.openings || 0), filled = Number(r.filled || 0);
        // A requisition with no openings has no coverage to report -- guard the
        // divide rather than rendering NaN%.
        var pct = openings > 0 ? Math.round(filled / openings * 100) : null;
        return '<tr><td><div class="name">' + esc(r.title) + '</div><div class="sub">' + esc(r.id) + '</div></td>' +
          '<td>' + esc(r.department || '—') + '</td><td>' + esc(r.shift || '—') + '</td>' +
          '<td>' + openings + '</td><td>' + filled + '</td>' +
          '<td>' + (pct == null ? '<span class="score none">—</span>'
            : '<span class="score ' + (pct < 70 ? 'bad' : pct < 90 ? 'warn' : '') + '">' + pct + '%</span>') + '</td>' +
          (compact ? '' : '<td>' + esc(r.priority || '—') + '</td>' +
            '<td><span class="status ' + (r.status === 'Filled' ? 'closed' : '') + '">' + esc(r.status || 'Open') + '</span></td>' +
            '<td><button class="suite-btn" data-fill="' + esc(r.id) + '">+ Fill</button> ' +
            '<button class="suite-btn danger" data-del="requisitions|' + esc(r.id) + '">Remove</button></td>') +
          '</tr>';
      }).join('') + '</tbody></table></div>';
  }
  /* ---------- requisitions ----------
     Beeline is the system of record for a request. Two exports arrive by email
     each morning -- the open reqs and the candidates on them -- and BOTH carry one
     row per (req x candidate), so neither file's row count is a requisition count.
     ReqsCore dedupes by Request-ID and hangs the candidates off their req.

     The exports are accumulated rather than saved one at a time: the candidate
     file alone knows nothing about openings, so saving it on its own would blank
     yesterday's counts. Once the loaded files between them carry every column,
     the board saves itself; until then the tab says which column is still missing
     and offers to save anyway.

     Hand-entered requests are left alone by an import (see mergeForSave) -- they
     may be the only record of a position Beeline does not carry yet. */
  function reqBoard() {
    // The Locations admin list is what turns a work-location number into a market
    // now that the daily export no longer carries the profit centre.
    return ReqsCore.fromRecords(state.stores.requisitions, state.stores.reqCandidates,
      state.stores.locations);
  }

  /* Site numbers this import can teach the Locations list.
     Worth surfacing loudly: the export that states the profit centre is the only
     thing that knows which market a site belongs to, and it is going away. Once it
     does, an unseeded site number is a req with no market for good. */
  function reqSiteLessons() {
    var srcs = state.reqSources || [];
    if (!srcs.length) return [];
    // Deliberately WITHOUT locations: learning has to read the profit centre, not
    // a market this list already supplied, or it would only teach itself.
    var learned = ReqsCore.learnSiteMarkets(ReqsCore.buildBoard({ sources: srcs }).reqs);
    var known = ReqsCore.siteMarketIndex(state.stores.locations);
    return learned.filter(function (l) { return known.get(l.code) !== l.market; });
  }

  function saveSiteLessons() {
    var lessons = reqSiteLessons();
    if (!lessons.length) return;
    var byCode = new Map();
    (state.stores.locations || []).forEach(function (l) { byCode.set(String(l.code), Object.assign({}, l)); });
    lessons.forEach(function (l) {
      var cur = byCode.get(l.code);
      // Only the market is written. A name somebody typed for this site is theirs.
      if (cur) { cur.market = l.market; return; }
      byCode.set(l.code, { id: 'LOC-' + l.code, code: l.code, name: '', market: l.market, active: true });
    });
    var records = [];
    byCode.forEach(function (v) { if (!v.id) v.id = 'LOC-' + v.code; records.push(v); });
    state.reqImport = { headline: 'Saving ' + lessons.length + ' site → market pairs…', warnings: [] };
    render();
    SuiteData.replaceCollection('locations', records).then(function () {
      state.stores.locations = records;
      state.admin.locations = records;
      state.reqImport = {
        headline: lessons.length + ' site number(s) added to Locations. Requests can now find their market ' +
          'from the work location, with no profit-centre column.',
        warnings: []
      };
      render();
    }).catch(function (err) {
      state.reqImport = { failed: true, headline: 'Could not save the locations: ' + err.message, warnings: [] };
      render();
    });
  }
  function reqBoardInMarket(board) {
    if (state.market === 'all') return board.reqs;
    return board.reqs.filter(function (r) { return !r.market || r.market === state.market; });
  }
  // Requisitions that reached the suite from only one side. The workbook is
  // client-owned and hand-edited, so a row it has and Beeline does not is usually
  // a req added there early -- or one left open after Beeline filled it.
  function otherReqs(board, kind) {
    var rows = kind === 'workbook' ? board.workbookOnly : board.manual;
    if (state.market === 'all') return rows;
    return (rows || []).filter(function (r) { return !r.market || r.market === state.market; });
  }

  function reqImportPanel() {
    var srcs = state.reqSources || [];
    var missing = srcs.length ? ReqsCore.missingColumns(srcs) : [];
    return '<section class="suite-panel req-import"><div class="suite-panel-head">' +
      '<h2>Daily Beeline export</h2><div class="suite-actions">' +
      (srcs.length ? '<button class="suite-btn" data-req-clear="1">Start over</button> ' : '') +
      (srcs.length && missing.length ? '<button class="suite-btn" data-req-save="1">Save anyway</button> ' : '') +
      '<label class="suite-btn cov-pick' + (srcs.length ? '' : ' primary') + '">Add export file' +
      '<input type="file" accept=".csv,.xlsx,.xls" data-req-file></label></div></div>' +
      '<p class="perf-note">Drop the <b>GEODIS Open Reqs</b> and <b>Candidate Status per Req</b> exports — in either ' +
      'order, or one combined file if the columns are all on it. Both files list one row per candidate, so the ' +
      'request list is shorter than the row count.</p>' +
      (srcs.length ? '<ul class="req-src">' + srcs.map(function (s) {
        return '<li><b>' + esc(s.fileName) + '</b> · ' + s.rowCount + ' rows · ' + s.reqs.length + ' requests' +
          (s.candidates.length ? ' · ' + s.candidates.length + ' candidates' : '') +
          ' <span class="cov-flag">' + esc(ReqsCore.describe(s)) + '</span></li>';
      }).join('') + '</ul>' : '') +
      (function () {
        var lessons = reqSiteLessons();
        if (!lessons.length) return '';
        return '<div class="import-report"><strong>' + lessons.length +
          ' work-location number(s) in this import state which market they belong to.</strong>' +
          '<p>The profit-centre column is the only thing that knows this, and it is not in the daily ' +
          'candidate export. Saving these to Locations lets every future import find a market from the ' +
          'work-location number alone.</p><p class="req-lessons">' +
          lessons.slice(0, 40).map(function (l) {
            return '<span><b>' + esc(l.code) + '</b> ' + esc(l.market) + '</span>';
          }).join('') + (lessons.length > 40 ? '<span>…and ' + (lessons.length - 40) + ' more</span>' : '') +
          '</p><button class="suite-btn primary" data-req-sites="1">Add ' + lessons.length +
          ' site(s) to Locations</button></div>';
      })() +
      reqGapReport(missing) +
      (state.reqImport ? shiftImportReport(state.reqImport) : '') + '</section>';
  }

  /* What the loaded export leaves unanswered -- stated as what is still unknown,
     not as which column is absent. Two of the columns the Beeline export cannot
     carry are covered from elsewhere: the market from the work-location number via
     the Locations list, and the openings count from the PLX workbook. Listing
     those as "missing" while the tab is plainly showing markets and openings would
     just teach people to ignore the panel. */
  var COVERED_BY = {
    profitCtr: 'Market comes from the work-location number instead, via Settings → Locations.',
    requested: 'Openings come from the PLX workbook instead, where it lists the request.'
  };
  function reqGapReport(missing) {
    if (!missing.length) return '';
    var board = reqBoard();
    var covered = [], unresolved = [];
    missing.forEach(function (m) {
      if (!COVERED_BY[m.key]) { unresolved.push(m); return; }
      var short = m.key === 'profitCtr'
        ? board.reqs.filter(function (r) { return !r.market; }).length
        : board.reqs.length - board.summary.reqsWithOpenings;
      covered.push({ label: m.label, note: COVERED_BY[m.key], short: short, total: board.reqs.length });
    });
    return (covered.length
      ? '<div class="import-report"><strong>Covered from another source</strong><ul>' +
        covered.map(function (c) {
          return '<li><b>' + esc(c.label) + '</b> — ' + esc(c.note) +
            (c.short ? ' <span class="warn-text">' + c.short + ' of ' + c.total +
              ' request(s) still have none.</span>' : ' <span class="ok-text">All ' + c.total + ' covered.</span>') +
            '</li>';
        }).join('') + '</ul></div>'
      : '') +
      (unresolved.length
        ? '<div class="import-report bad"><strong>Not reported by this export</strong><ul>' +
          unresolved.map(function (m) { return '<li><b>' + esc(m.label) + '</b> — ' + esc(m.why) + '</li>'; }).join('') +
          '</ul></div>'
        : '');
  }

  function reqMetrics(s) {
    return '<div class="metric-strip">' +
      metric('Open requests', s.reqs, s.noCandidates + ' with nobody submitted') +
      metric('Positions', s.requested == null ? '—' : s.requested,
        s.requested == null ? 'No openings count in any loaded source'
          : s.reqsWithOpenings < s.reqs
            ? 'Across the ' + s.reqsWithOpenings + ' of ' + s.reqs + ' requests whose openings are known'
            : 'Seats requested across all requests') +
      metric('Hired', s.hired == null ? '—' : s.hired,
        s.fillPct == null ? 'No openings count to measure against'
          : s.reqsWithOpenings < s.reqs
            ? s.hiredAgainstRequested + ' of those against a known opening — ' + s.fillPct + '% of ' + s.requested + ' seats'
            : s.fillPct + '% of requested',
        s.fillPct == null ? '' : s.fillPct >= 90 ? 'green' : 'orange') +
      metric('Short by', s.shortBy == null ? '—' : s.shortBy, 'Seats still to fill',
        s.shortBy ? 'orange' : 'green') +
      '</div>' +
      (s.stages && (s.stages.offered || s.stages.review || s.stages.declined)
        ? '<div class="req-stages">' +
          [['hired', 'Offer confirmed'], ['offered', 'Offer pending'], ['review', 'Pending'],
           ['declined', 'Rejected'], ['other', 'Other']]
            .filter(function (x) { return s.stages[x[0]]; })
            .map(function (x) {
              return '<span><b>' + s.stages[x[0]] + '</b> ' + esc(x[1]) + '</span>';
            }).join('') + '</div>'
        : '');
  }

  /* Start-date windows. A request whose start date has passed and whose seats are
     not filled is the one somebody is being asked about today, so that is its own
     bucket rather than something to work out from a column of dates. */
  var REQ_WHEN = [
    ['all', 'Any start date'],
    ['overdue', 'Started, still short'],
    ['past', 'Start date passed'],
    ['week', 'Starts within 7 days'],
    ['month', 'Starts within 30 days'],
    ['later', 'Starts later than 30 days'],
    ['none', 'No start date']
  ];
  function reqWhenMatch(r, key, today) {
    if (key === 'all') return true;
    if (!r.startDate) return key === 'none';
    if (key === 'none') return false;
    var days = Math.round((new Date(r.startDate + 'T00:00:00') - today) / 86400000);
    if (key === 'overdue') return days <= 0 && r.shortBy !== 0;
    if (key === 'past') return days <= 0;
    if (key === 'week') return days > 0 && days <= 7;
    if (key === 'month') return days > 0 && days <= 30;
    if (key === 'later') return days > 30;
    return true;
  }

  var REQ_HEALTH = [
    ['all', 'All requests'], ['short', 'Not yet filled'], ['empty', 'Nobody submitted'],
    ['submitted', 'Candidates in flight'], ['partial', 'Partly filled'], ['filled', 'Filled']
  ];
  /* Sites offered are the ones present in the CHOSEN MARKET, not every site in the
     file: a picker listing sites that cannot match anything is a picker that
     filters to nothing and looks broken. */
  function reqSiteOptions(inMarket) {
    var counts = {};
    inMarket.forEach(function (r) {
      if (!r.site) return;
      counts[r.site] = (counts[r.site] || 0) + 1;
    });
    return Object.keys(counts).sort().map(function (code) {
      var row = inMarket.filter(function (r) { return r.site === code; })[0];
      var name = siteName(code) || row.city || '';
      return { code: code, label: code + (name ? ' · ' + name : ''), count: counts[code] };
    });
  }
  function reqFilters(inMarket) {
    var sites = reqSiteOptions(inMarket);
    var noSite = inMarket.filter(function (r) { return !r.site; }).length;
    return '<div class="filter-row">' +
      '<input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="Search by request, job, manager, site, or candidate…">' +
      (sites.length > 1 || noSite
        ? '<select class="suite-select" id="req-site"><option value="all">All sites</option>' +
          sites.map(function (o) {
            return '<option value="' + esc(o.code) + '" ' + (state.reqSite === o.code ? 'selected' : '') + '>' +
              esc(o.label) + ' (' + o.count + ')</option>';
          }).join('') +
          (noSite ? '<option value="none" ' + (state.reqSite === 'none' ? 'selected' : '') +
            '>No site number (' + noSite + ')</option>' : '') +
          '</select>'
        : '') +
      '<select class="suite-select" id="req-when">' + REQ_WHEN.map(function (o) {
        return '<option value="' + o[0] + '" ' + (state.reqWhen === o[0] ? 'selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select>' +
      '<select class="suite-select" id="req-health">' + REQ_HEALTH.map(function (o) {
        return '<option value="' + o[0] + '" ' + (state.reqHealth === o[0] ? 'selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select></div>';
  }
  function reqMatches(r, q) {
    if (!q) return true;
    if ((r.id + ' ' + r.jobPosition + ' ' + r.hiringManager + ' ' + r.reportsTo + ' ' +
      r.location + ' ' + r.market + ' ' + r.site + ' ' + siteName(r.site)).toLowerCase().indexOf(q) !== -1) return true;
    // Searching a candidate's name should find the request they are sitting on.
    return r.candidates.some(function (c) {
      return (c.name + ' ' + c.beelineId + ' ' + c.externalId).toLowerCase().indexOf(q) !== -1;
    });
  }
  function reqFilter(rows) {
    var q = state.query.trim().toLowerCase(), h = state.reqHealth, site = state.reqSite;
    // Local midnight, so "starts in 3 days" counts calendar days, not 72 hours.
    var todayLocal = new Date(today() + 'T00:00:00');
    var out = rows.filter(function (r) {
      if (site === 'none') { if (r.site) return false; }
      else if (site !== 'all' && r.site !== site) return false;
      if (h === 'short') { if (r.shortBy === 0) return false; }
      else if (h !== 'all' && r.health !== h) return false;
      if (!reqWhenMatch(r, state.reqWhen, todayLocal)) return false;
      return reqMatches(r, q);
    });
    return sortRows(out, 'requisitions', reqSortValue);
  }

  /* The sort keys the table header offers. 'short' is the default and deliberately
     puts the most short-handed first, so a request nobody has filled outranks one
     that is nearly done however the rest of the row reads. */
  function reqSortValue(r, key) {
    if (key === 'request') return r.jobPosition || '';
    if (key === 'site') return r.site || '';
    if (key === 'positions') return r.requested;
    if (key === 'submitted') return r.candidateCount;
    if (key === 'filled') return r.fillPct;
    if (key === 'start') return r.startDate || '';
    if (key === 'manager') return r.hiringManager || '';
    if (key === 'short') return r.shortBy;
    // sortRows breaks ties on 'name'.
    return (r.jobPosition || '') + ' ' + r.id;
  }

  /* When the seat is wanted. A start date already past on a request still short is
     the one somebody is being asked about, so it says how far past rather than
     printing a date and leaving the arithmetic to the reader. */
  function startCell(r) {
    if (!r.startDate) return '<span class="score none">—</span>';
    var days = Math.round((new Date(r.startDate + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
    var when = days === 0 ? 'today' : days > 0 ? 'in ' + days + 'd' : Math.abs(days) + 'd ago';
    var late = days <= 0 && r.shortBy !== 0;
    return '<div class="name' + (late ? ' warn-text' : '') + '">' + esc(r.startDate) + '</div>' +
      '<div class="sub' + (late ? ' warn-text' : '') + '">' + esc(when) + '</div>';
  }

  function reqHealthChip(r) {
    var label = { filled: 'Filled', partial: 'Partly filled', submitted: 'In flight',
      empty: 'Nobody submitted', unknown: 'Not reported' }[r.health];
    var cls = { filled: 'ok', partial: 'warn', submitted: 'warn', empty: 'bad', unknown: '' }[r.health];
    return '<span class="cov-status ' + cls + '">' + esc(label) + '</span>';
  }

  /* The candidate list a request expands into. Where the export carries Internal
     Status, each person's own stage is shown. Where it does not, the column says
     so rather than leaving a blank that reads as "no decision yet" -- the request
     counts are then the only thing that knows who progressed. */
  function reqCandidateRows(r) {
    if (!r.candidateCount) {
      return '<tr class="req-detail"><td colspan="8"><div class="req-none">Nobody has been submitted to this request yet.</div></td></tr>';
    }
    var breakdown = Object.keys(r.statusCounts || {}).map(function (k) {
      return r.statusCounts[k] + ' ' + k.toLowerCase();
    }).join(' · ');
    var head = r.candidateCount + ' submitted' + (breakdown ? ' · ' + breakdown : '') +
      (r.hasCandidateStatus ? '' :
        ' <span class="req-note">This export does not say which candidate reached which stage.</span>');
    return '<tr class="req-detail"><td colspan="8"><div class="req-cands">' +
      '<div class="req-cands-head">' + head + '</div>' +
      '<table class="suite-table"><thead><tr><th>Candidate</th><th>Status</th><th>Beeline ID</th>' +
      '<th>External ID</th><th>On roster</th></tr></thead><tbody>' +
      r.candidates.map(function (c) {
        return '<tr><td><div class="' + (c.badge ? 'name link' : 'name') + '"' +
          (c.badge ? ' data-profile="' + esc(c.badge) + '"' : '') + '>' + esc(c.name) + '</div></td>' +
          '<td>' + (c.statusLabel
            ? '<span class="cov-status ' + esc(c.tone || '') + '">' + esc(c.statusLabel) + '</span>'
            : '<span class="score none">Not reported</span>') + '</td>' +
          '<td class="mono">' + esc(c.beelineId || '—') + '</td>' +
          '<td class="mono">' + esc(c.externalId || '—') + '</td>' +
          '<td>' + (c.badge ? '<span class="cov-dot on">' + esc(c.rosterName || 'Yes') + '</span>'
            : '<span class="cov-dot off">Not matched</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div></td></tr>';
  }

  function beelineReqTable(rows) {
    return '<div class="suite-table-wrap"><table class="suite-table req-table"><thead><tr>' +
      '<th></th>' + sortHead('requisitions', 'request', 'Request') +
      sortHead('requisitions', 'start', 'Starts') +
      sortHead('requisitions', 'site', 'Site / market') +
      sortHead('requisitions', 'positions', 'Positions') +
      sortHead('requisitions', 'submitted', 'Submitted') +
      sortHead('requisitions', 'filled', 'Filled') +
      sortHead('requisitions', 'manager', 'Hiring manager') +
      '</tr></thead><tbody>' +
      rows.slice(0, MAX_ROWS).map(function (r) {
        var open = !!state.reqExpanded[r.id];
        return '<tr class="req-row ' + (open ? 'open' : '') + '" data-req-expand="' + esc(r.id) + '">' +
          '<td class="req-caret"><span>' + (open ? '▾' : '▸') + '</span></td>' +
          '<td><div class="name">' + esc(r.jobPosition || 'Beeline request') + '</div>' +
          '<div class="sub">' + esc(r.id) + '</div></td>' +
          '<td>' + startCell(r) + '</td>' +
          '<td><div class="name site-code">' + esc(r.site || '—') +
          (siteLabel(r) ? ' <span class="site-name">' + esc(siteLabel(r)) + '</span>' : '') +
          '</div><div class="sub">' + esc(r.market || 'No market') +
          (r.marketFrom === 'site' ? ' <span class="cov-flag" title="Derived from the work-location number, not read off a profit centre.">from site</span>' : '') +
          '</div></td>' +
          '<td>' + (r.requested == null ? '<span class="score none">—</span>' : r.requested) +
          (r.requestedFrom === 'workbook' ? '<div class="sub">from the workbook</div>' : '') +
          (r.openingsDiffer ? '<div class="sub warn-text">workbook says ' + r.workbookOpenings + '</div>' : '') +
          '</td>' +
          '<td>' + r.candidateCount + '</td>' +
          '<td>' + (r.fillPct == null
            ? '<span class="score none">—</span>'
            : '<span class="score ' + (r.fillPct < 70 ? 'bad' : r.fillPct < 90 ? 'warn' : '') + '">' +
              r.hired + ' / ' + r.requested + '</span>') +
          ' ' + reqHealthChip(r) + '</td>' +
          '<td><div class="name">' + esc(r.hiringManager || '—') + '</div>' +
          (r.reportsTo ? '<div class="sub">reports to ' + esc(r.reportsTo) + '</div>' : '') + '</td></tr>' +
          (open ? reqCandidateRows(r) : '');
      }).join('') + '</tbody></table></div>' + rowCap(Math.min(rows.length, MAX_ROWS), rows.length);
  }
  /* What a site is called. The Locations admin list wins, because somebody typed
     it deliberately; otherwise the city the work location names. Several sites can
     share a city -- 1502, 1517 and 1519 are all Romeoville -- so the number is the
     identifier and the name only ever qualifies it. */
  function siteName(code) {
    if (!code) return '';
    var row = (state.stores.locations || []).filter(function (l) {
      return String(l.code) === String(code);
    })[0];
    return row && row.name ? row.name : '';
  }
  function siteLabel(r) {
    var name = siteName(r.site) || r.city || '';
    return name + (name && r.state ? ', ' + r.state : '');
  }

  function requisitions() {
    if (!state.storesLoaded) return loadingPanel('requisitions');
    var board = reqBoard();
    ReqsCore.linkRoster(board.reqs, state.profiles, SuiteData.normBadge);
    var inMarket = reqBoardInMarket(board);
    var rows = reqFilter(inMarket);
    var manual = otherReqs(board, 'manual');
    var wbOnly = otherReqs(board, 'workbook');

    var body = board.reqs.length
      ? reqMetrics(summarizeVisible(inMarket)) +
        (board.warnings.length ? warnList(board.warnings) : '') +
        reqReconNote(board, inMarket) +
        '<section class="suite-panel">' + reqFilters(inMarket) +
        (rows.length ? beelineReqTable(rows)
          : empty('No requests match those filters', 'Widen the search or the status filter.')) +
        '</section>'
      : '<section class="suite-panel"><div class="workflow-empty">' +
        'No Beeline requests loaded yet. Add the daily export above to see open requests and who is on them.' +
        '</div></section>';

    return hero('Beeline Requests', 'Open requests and the candidates attached to them.', 'requisition', 'New request') +
      reqImportPanel() + body +
      (wbOnly.length
        ? '<section class="suite-panel"><div class="suite-panel-head"><h2>In the PLX workbook, not in Beeline</h2></div>' +
          '<p class="perf-note">The workbook is edited by the client, so a request can appear there before Beeline has it — ' +
          'or stay open after Beeline filled it. Beeline is the system of record; these are left for a person to settle.</p>' +
          reqTable(wbOnly, false) + '</section>'
        : '') +
      (manual.length
        ? '<section class="suite-panel"><div class="suite-panel-head"><h2>Added by hand</h2></div>' +
          '<p class="perf-note">Requests typed into the suite rather than imported from Beeline or the workbook. ' +
          'An import leaves these alone.</p>' +
          reqTable(manual, false) + '</section>'
        : '');
  }

  /* What the two sources disagree about. Shown above the table rather than buried
     on the rows it affects, because "the workbook has not caught up" is a thing to
     go and fix, not a per-row footnote. */
  function reqReconNote(board, visible) {
    var s = summarizeVisible(visible), bits = [];
    var unknown = {};
    visible.forEach(function (r) { if (r.marketUnknownSite) unknown[r.marketUnknownSite] = true; });
    var sites = Object.keys(unknown);
    if (sites.length) {
      bits.push('<b>' + sites.length + '</b> work-location number(s) are not in the Locations list, so those ' +
        'requests have no market: ' + sites.slice(0, 12).map(esc).join(', ') +
        (sites.length > 12 ? '…' : '') + '. Add them under Settings → Locations.');
    }
    if (s.reqsWithOpenings < s.reqs) {
      bits.push('<b>' + (s.reqs - s.reqsWithOpenings) + '</b> request(s) have no openings count from any source, ' +
        'so they show no fill figure. The PLX workbook supplies it where it lists the request.');
    }
    var differ = visible.filter(function (r) { return r.openingsDiffer; }).length;
    if (differ) {
      bits.push('<b>' + differ + '</b> request(s) where the workbook and Beeline disagree on how many are wanted.');
    }
    if (board.workbookOnly && board.workbookOnly.length) {
      bits.push('<b>' + board.workbookOnly.length + '</b> request(s) in the PLX workbook that Beeline does not have.');
    }
    if (!bits.length) return '';
    return '<div class="warn-banner"><strong>PLX workbook vs. Beeline</strong><ul>' +
      bits.map(function (b) { return '<li>' + b + '</li>'; }).join('') + '</ul></div>';
  }

  // The metric strip reflects what the market filter is showing, not the whole file.
  // The metric strip reflects what the market filter is showing, so it re-totals
  // the visible rows through the same rules the core summary uses.
  function summarizeVisible(reqs) {
    var s = { reqs: reqs.length, candidates: 0, requested: null, hired: null,
      hiredAgainstRequested: null, reqsWithOpenings: 0, shortBy: null,
      noCandidates: 0, stages: { hired: 0, offered: 0, review: 0, declined: 0, other: 0 } };
    reqs.forEach(function (r) {
      s.candidates += r.candidateCount;
      if (r.stages) ReqsCore.STAGE_ORDER.forEach(function (k) { s.stages[k] += r.stages[k] || 0; });
      if (!r.candidateCount) s.noCandidates++;
      if (r.requested != null) {
        s.requested = (s.requested || 0) + r.requested;
        s.reqsWithOpenings++;
        if (r.hired != null) s.hiredAgainstRequested = (s.hiredAgainstRequested || 0) + r.hired;
      }
      if (r.hired != null) s.hired = (s.hired || 0) + r.hired;
      if (r.shortBy != null) s.shortBy = (s.shortBy || 0) + r.shortBy;
    });
    s.fillPct = s.requested == null || s.hiredAgainstRequested == null || s.requested <= 0
      ? null : Math.round(s.hiredAgainstRequested / s.requested * 100);
    return s;
  }
  function warnList(ws) {
    return '<div class="warn-banner"><strong>Check these before acting on the numbers</strong><ul>' +
      ws.slice(0, 8).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') +
      (ws.length > 8 ? '<li>…and ' + (ws.length - 8) + ' more.</li>' : '') + '</ul></div>';
  }

  function readReqExport(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        // raw:true keeps 04/27/2026 as written; a spreadsheet reader would
        // reformat it to 4/27/26. ReqsCore.isoDate accepts either, but there is no
        // reason to hand it the lossier one.
        var wb = XLSX.read(e.target.result, { type: 'array', raw: true });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
        var parsed = ReqsCore.parseExport(aoa, file.name);
        if (parsed.warnings.length && !parsed.reqs.length) throw new Error(parsed.warnings[0]);
        if (!parsed.reqs.length) throw new Error('No requests were found in this file.');
        state.reqSources = (state.reqSources || [])
          .filter(function (s) { return s.fileName !== file.name; })
          .concat([parsed]);
        state.reqImport = null;
        // Everything the board needs is loaded: save without a second click.
        if (!ReqsCore.missingColumns(state.reqSources).length) saveReqImport();
        else render();
      } catch (err) {
        console.error(err);
        state.reqImport = { failed: true, headline: 'Could not read "' + file.name + '": ' + err.message, warnings: [] };
        render();
      }
    };
    reader.onerror = function () { alert('Failed to read "' + file.name + '".'); };
    reader.readAsArrayBuffer(file);
  }

  function saveReqImport() {
    var srcs = state.reqSources || [];
    if (!srcs.length) return;
    // With the Locations list, so a request whose export carried no profit centre
    // still gets its market from the work-location number BEFORE it is stored --
    // otherwise the market would be derived for display and blank on the record,
    // and the header market picker would never learn it exists.
    var board = ReqsCore.buildBoard({ sources: srcs, locations: state.stores.locations });
    var reqRecords = ReqsCore.toReqRecords(board);
    var candRecords = ReqsCore.toCandidateRecords(board);
    var merged = ReqsCore.mergeForSave(state.stores.requisitions, reqRecords);
    state.reqImport = { headline: 'Saving ' + reqRecords.length + ' requests…', warnings: [] };
    render();

    Promise.all([
      SuiteData.replaceCollection('requisitions', merged),
      SuiteData.replaceCollection('reqCandidates', candRecords)
    ]).then(function () {
      state.stores.requisitions = merged;
      state.stores.reqCandidates = candRecords;
      rebuild();
      var missing = ReqsCore.missingColumns(srcs);
      state.reqImport = {
        headline: reqRecords.length + ' requests and ' + candRecords.length + ' candidates imported from ' +
          srcs.length + ' file' + (srcs.length === 1 ? '' : 's'),
        warnings: board.warnings.concat(missing.map(function (m) {
          return 'Saved without "' + m.label + '" — ' + m.why + '.';
        }))
      };
      render();
    }).catch(function (err) {
      state.reqImport = { failed: true, headline: 'Could not save the requests: ' + err.message, warnings: [] };
      render();
    });
  }


  /* ---------- reconciliation ----------
     The existing tool is not reimplemented here. Its DOM (#recon-main, with all
     of its listeners) is MOVED into the suite content area, and moved back out
     before any re-render wipes the shell. */
  function reconciliation() {
    return staleNote(state.plx.sync && state.plx.sync.syncedAt, 'The PLX workbook') +
      staleNote(state.updatedAt, 'The RC / Beeline roster') +
      plxBar() + '<div id="recon-mount"></div>';
  }

  /* A feed that stops arriving looks exactly like a feed with nothing new, and
     the difference only showed up in Power Automate's raw output. Anything the
     tool depends on being refreshed says how old it is, and says so loudly once
     it is older than a run cycle. */
  var STALE_AFTER_HOURS = 20;      // 8am and 4pm runs; 20h means two were missed
  function hoursSince(iso) {
    var t = Date.parse(iso || '');
    if (isNaN(t)) return null;
    return (Date.now() - t) / 3600000;
  }
  function ageLabel(iso) {
    var h = hoursSince(iso);
    if (h == null) return '';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + ' minutes ago';
    if (h < 48) return Math.round(h) + ' hours ago';
    return Math.round(h / 24) + ' days ago';
  }
  function staleNote(iso, what) {
    var h = hoursSince(iso);
    if (h == null || h < STALE_AFTER_HOURS) return '';
    return '<div class="warn-banner"><strong>' + esc(what) + ' is ' + esc(ageLabel(iso)) + '</strong>' +
      '<p>It should refresh twice a day. This usually means the Power Automate flow is failing — ' +
      'a SharePoint connection whose token has expired is the common cause, and it shows as a 401 ' +
      'in the flow run history.</p></div>';
  }

  function plxBar() {
    var p = state.plx, sync = p.sync;
    var when = sync && sync.syncedAt ? shortWhen(sync.syncedAt) : '';
    return '<section class="suite-panel plx-bar"><div class="plx-info">' +
      '<strong>Roster, shifts and open orders</strong>' +
      (sync && sync.syncedAt
        ? '<span>From the PLX workbook · ' + esc(sync.shiftTags || 0) + ' shift tags across ' +
          esc(sync.sites || 0) + ' sites · ' + esc(sync.openOrders || 0) + ' open orders · synced ' +
          esc(when) + ' (' + esc(ageLabel(sync.syncedAt)) + ')</span>'
        : '<span class="warn-text">No PLX workbook has been uploaded yet, so there is nothing ' +
          'to reconcile against. Upload it on the On-Premise page.</span>') +
      (p.note ? '<span class="plx-note">' + esc(p.note) + '</span>' : '') +
      '</div>' +
      '<button class="suite-btn" data-nav="coverage">Upload a workbook</button></section>' +
      (sync && sync.warnings && sync.warnings.length
        ? '<div class="warn-banner cov-warn"><strong>From the last workbook</strong><ul>' +
          sync.warnings.slice(0, 6).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') +
          (sync.warnings.length > 6 ? '<li>…and ' + (sync.warnings.length - 6) + ' more.</li>' : '') +
          '</ul></div>'
        : '');
  }

  function mountRecon() {
    var main = document.getElementById('recon-main'), slot = document.getElementById('recon-mount');
    if (main && slot && main.parentNode !== slot) slot.appendChild(main);
  }
  function unmountRecon() {
    var main = document.getElementById('recon-main');
    if (main && main.parentNode !== document.body) document.body.appendChild(main);
  }

  /* ---------- render ---------- */
  var VIEWS = {
    overview: overview, associates: associates, profile: profileView,
    coverage: coverageView, attendance: attendance, timeoff: timeoff,
    payroll: payrollView, requisitions: requisitions, reconciliation: reconciliation,
    settings: settingsView, tasks: tasksView
  };
  function render() {
    unmountRecon();   // rescue the reconciliation DOM before innerHTML wipes it
    var body = (VIEWS[state.view] || overview)();
    root.innerHTML = '<div class="suite-layout">' + navHtml() + '<div class="suite-main">' + headerHtml() +
      '<main class="suite-content">' + body + '</main></div></div>';
    if (state.view === 'reconciliation') mountRecon();
  }
  function go(view, badge) {
    state.view = view;
    if (badge !== undefined) state.profileBadge = badge;
    state.query = '';
    render();
    window.scrollTo(0, 0);
  }

  /* ---------- modals ---------- */
  /* Offers the EID as the value, because that is the number people have in
     front of them. The field still accepts a badge or a timeclock id -- see
     findByAnyId -- so nobody is forced to look up a different number to type
     the one they already know. */
  function rosterDatalist() {
    return '<datalist id="roster-list">' + allProfiles().slice(0, 2000).map(function (p) {
      return '<option value="' + esc(p.empNumber || p.badge) + '">' + esc(p.name) +
        ' · ' + esc(p.market) + (p.empNumber ? '' : ' · badge ' + esc(p.badge)) + '</option>';
    }).join('') + '</datalist>';
  }
  function field(label, name, type, value, opts) {
    var input;
    if (type === 'select') {
      input = '<select name="' + name + '">' + (opts || []).map(function (o) {
        return '<option ' + (o === value ? 'selected' : '') + '>' + esc(o) + '</option>';
      }).join('') + '</select>';
    } else if (type === 'badge' || type === 'badge-optional') {
      input = '<input name="' + name + '" list="roster-list" value="' + esc(value) + '"' +
        (type === 'badge' ? ' required' : '') + ' placeholder="EID, badge, or name">' + rosterDatalist();
    } else {
      input = '<input name="' + name + '" type="' + type + '" value="' + esc(value) + '"' +
        (type === 'number' ? ' min="0" step="0.5"' : '') + '>';
    }
    return '<label class="suite-field"><span>' + esc(label) + '</span>' + input + '</label>';
  }
  function modal(type, badge) {
    var fields = '', title = '';
    if (type === 'timeoff') {
      title = 'New time-off request';
      fields = field('Associate', 'badge', 'badge', badge || '') +
        field('Type', 'type', 'select', 'PTO', TIME_OFF_TYPES) +
        field('Start', 'start', 'date', today()) + field('End', 'end', 'date', today()) +
        field('Hours', 'hours', 'number', '8') +
        field('Status', 'status', 'select', TimeOffCore.DEFAULT_STATUS, TimeOffCore.STATUS_KEYS) +
        field('Notes', 'notes', 'text', '');
    } else if (type === 'task') {
      title = 'Raise a task';
      fields = field('What needs doing', 'title', 'text', '') +
        field('Kind', 'kind', 'select', TasksCore.DEFAULT_KIND,
          TasksCore.KINDS.map(function (k) { return k.label; })) +
        // Optional: plenty of tasks are about a system or a site, not a person.
        field('Associate (optional)', 'badge', 'badge-optional', badge || '') +
        field('Detail', 'detail', 'text', '');
    } else {
      title = 'New Beeline request';
      fields = field('Req ID', 'id', 'text', 'REQ-' + Date.now().toString().slice(-6)) +
        field('Job title', 'title', 'text', '') +
        field('Department', 'department', 'select', 'Warehouse Operations',
          ['Warehouse Operations', 'Yard Operations', 'Transportation', 'Support Services']) +
        field('Shift', 'shift', 'select', '1st', ['1st', '2nd', '3rd']) +
        field('Market', 'market', 'select', state.market === 'all' ? '' : state.market, [''].concat(markets())) +
        field('Openings', 'openings', 'number', '1') + field('Filled', 'filled', 'number', '0') +
        field('Priority', 'priority', 'select', 'Medium', ['Low', 'Medium', 'High', 'Critical']) +
        field('Due date', 'due', 'date', today());
    }
    document.body.insertAdjacentHTML('beforeend',
      '<div class="suite-modal-backdrop" id="suite-modal"><div class="suite-modal">' +
      '<div class="suite-modal-head"><h3>' + esc(title) + '</h3><button class="suite-btn" data-close>×</button></div>' +
      '<form class="suite-form" data-form="' + type + '">' + fields +
      '<div class="suite-modal-actions"><button type="button" class="suite-btn" data-close>Cancel</button>' +
      '<button class="suite-btn primary">Save record</button></div></form></div></div>');
  }

  /* ---------- persistence ----------
     Every write goes to the shared collection first; the local list and the
     re-render follow. A failed write is surfaced, never silently swallowed. */
  function persist(name, record, localKey) {
    return SuiteData.saveRecord(name, record).then(function (saved) {
      if (saved && saved.record) record = saved.record;
      if (saved && saved.associatePto) state.stores.associatePto = saved.associatePto;
      var list = state.stores[localKey], i = list.findIndex(function (x) { return x.id === record.id; });
      if (i === -1) list.push(record); else list[i] = Object.assign({}, list[i], record);
      rebuild(); render();
    }).catch(function (err) {
      console.warn('Could not save the ' + name + ' record.', err);
      alert('That record could not be saved, so it was not shared with anyone else.\n\n' + err.message);
    });
  }
  function remove(name, localKey, id) {
    return SuiteData.deleteRecord(name, id).then(function () {
      state.stores[localKey] = state.stores[localKey].filter(function (x) { return x.id !== id; });
      rebuild(); render();
    }).catch(function (err) {
      console.warn('Could not delete the ' + name + ' record.', err);
      alert('That record could not be removed.\n\n' + err.message);
    });
  }
  /* Attendance is absent on purpose: it is read from the PLX workbook and
     written nowhere, so it has no writer key here. */
  var LOCAL_KEY = { timeoff: 'timeOff', requisitions: 'requisitions',
    discrepancies: 'discrepancies', users: 'users', locations: 'locations', shiftTypes: 'shiftTypes',
    appConfig: 'appConfig', tasks: 'tasks', contacts: 'contacts' };

  /* Settings rows live in state.admin, not state.stores, so they get their own
     writer. It reloads the collection after each write rather than patching in
     place: an admin page is low-traffic, and being certain what was stored
     matters more than saving a round trip. */
  function persistAdmin(which, patch) {
    SuiteData.saveRecord(which, patch).then(function () {
      return SuiteData.loadCollection(which);
    }).then(function (rows) {
      state.admin[which] = rows;
      render();
    }).catch(function (err) {
      alert('That change could not be saved.\n\n' + err.message);
    });
  }

  /* ---------- events ---------- */
  root.addEventListener('click', function (e) {
    var nav = e.target.closest('[data-nav]');
    if (nav) { go(nav.dataset.nav); return; }

    var sh = e.target.closest('[data-set-shift]');
    if (sh) { setShift(sh.dataset.setShift); return; }

    var stab = e.target.closest('[data-settings-tab]');
    if (stab) {
      state.admin.tab = stab.dataset.settingsTab;
      if (state.admin.tab !== 'account' && !state.admin.loaded) loadAdminData();
      render();
      return;
    }
    if (e.target.closest('[data-sign-out]')) { SuiteAuth.signOut(); return; }
    var doSign = e.target.closest('[data-signin-do]');
    if (doSign) {
      e.preventDefault();
      var form = doSign.closest('[data-signin]');
      var email = form.querySelector('[name="email"]').value;
      var pw = form.querySelector('[name="password"]').value;
      var what = doSign.dataset.signinDo;
      if (what === 'reset') SuiteAuth.resetPassword(email);
      else if (what === 'create') SuiteAuth.createAccount(email, pw);
      else SuiteAuth.signIn(email, pw);
      return;
    }
    var addTo = e.target.closest('[data-list-add]');
    if (addTo) {
      var which = addTo.dataset.listAdd;
      var rec = LISTS[which].blank();
      rec.id = which.slice(0, 3).toUpperCase() + Date.now();
      persistAdmin(which, rec);
      return;
    }
    var lt = e.target.closest('[data-list-toggle]');
    if (lt) {
      var bits = lt.dataset.listToggle.split('|');
      var row = (state.admin[bits[0]] || []).filter(function (x) { return x.id === bits[1]; })[0];
      if (row) persistAdmin(bits[0], { id: row.id, active: row.active === false });
      return;
    }
    var ut = e.target.closest('[data-user-toggle]');
    if (ut) {
      var u = state.admin.users.filter(function (x) { return AuthCore.normalizeEmail(x.email) === ut.dataset.userToggle; })[0];
      if (u) persistAdmin('users', { id: AuthCore.normalizeEmail(u.email), email: u.email, enabled: !(u.enabled !== false) });
      return;
    }
    var sortCell = e.target.closest('[data-sort]');
    if (sortCell) {
      var parts = sortCell.dataset.sort.split(':'), tbl = parts[0], col = parts[1];
      var st = state.sort[tbl];
      // Clicking the column you are already on reverses it; a new column starts
      // ascending, which is what people expect of a name or a site number.
      if (st.key === col) st.dir = -st.dir; else { st.key = col; st.dir = 1; }
      render();
      return;
    }
    var prof = e.target.closest('[data-profile]');
    if (prof) { go('profile', prof.dataset.profile); return; }

    var copyPhone = e.target.closest('[data-phone-copy]');
    if (copyPhone) {
      var num = copyPhone.dataset.phoneCopy;
      var done = function () {
        copyPhone.textContent = 'Copied';
        setTimeout(function () { copyPhone.textContent = 'Copy'; }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(num).then(done, function () { window.prompt('Copy this number:', num); });
      } else {
        window.prompt('Copy this number:', num);
      }
      return;
    }

    var editPhone = e.target.closest('[data-phone-edit]');
    if (editPhone) {
      var pr = profile(editPhone.dataset.phoneEdit);
      if (!pr) return;
      var typed = window.prompt('Mobile number for ' + pr.name +
        '\n\nUsed to look them up in TextUs and Vonage.', ContactsCore.format(pr.phone));
      if (typed === null) return;                       // cancelled
      var trimmed = String(typed).trim();
      // Clearing it is a deliberate act and has to be possible; a typo is not.
      if (trimmed && !ContactsCore.isValid(trimmed)) {
        alert('"' + trimmed + '" is not a ten-digit US number, so it was not saved.\n\n' +
          'A wrong number is worse than none -- it reaches somebody, just not this person.');
        return;
      }
      var actor = currentActor(true);
      if (!actor) return;
      persist('contacts', ContactsCore.record({
        badge: pr.badge, name: pr.name, phone: trimmed,
        eid: pr.wfmId || '', nameKey: ScheduleCore.rosterKey(pr.name),
        source: 'Entered by hand'
      }, actor, new Date()), 'contacts');
      return;
    }

    /* Getting somebody onto the timeclock is a job that outlives this page, so
       it becomes a task rather than a note that disappears on the next upload.
       The form opens filled in -- the point is one click, not a blank form. */
    var addClock = e.target.closest('[data-add-clock]');
    if (addClock) {
      var who = addClock.dataset.addClock ? profile(addClock.dataset.addClock) : null;
      var nm = who ? who.name : (addClock.dataset.addClockName || 'this associate');
      modal('task', who ? who.badge : '');
      var f = document.querySelector('[data-form="task"]');
      if (f) {
        f.querySelector('[name="title"]').value = 'Add ' + nm + ' to the timeclock';
        f.querySelector('[name="kind"]').value = TasksCore.kindMeta('system').label;
        f.querySelector('[name="detail"]').value =
          'On the PLX workbook roster and scheduled, but absent from the on-premise report, ' +
          'so there is no timeclock record yet.' +
          (who && who.empNumber ? ' EID ' + who.empNumber + '.' : '');
      }
      return;
    }

    if (e.target.closest('[data-add-task]')) { modal('task', ''); return; }

    var done = e.target.closest('[data-task-done]');
    if (done) {
      var actor = currentActor(true);
      if (!actor) return;
      var t = (state.stores.tasks || []).filter(function (x) { return x.id === done.dataset.taskDone; })[0];
      if (!t) return;
      var patch = TasksCore.pipeline.applyStatus(t, 'Complete', actor, new Date());
      patch.updatedAt = patch.statusUpdatedAt;
      persist('tasks', patch, 'tasks');
      return;
    }

    var add = e.target.closest('[data-add]');
    if (add) { modal(add.dataset.add, add.dataset.badge || ''); return; }

    var del = e.target.closest('[data-del]');
    if (del) {
      var parts = del.dataset.del.split('|'), name = parts[0], id = parts.slice(1).join('|');
      if (!confirm('Remove this record for everyone?')) return;
      if (state.admin[name] !== undefined) {
        SuiteData.deleteRecord(name, id).then(function () {
          return SuiteData.loadCollection(name);
        }).then(function (rows) { state.admin[name] = rows; render(); });
      } else {
        remove(name, LOCAL_KEY[name], id);
      }
      return;
    }
    if (e.target.closest('[data-open-connections]')) {
      state.admin.tab = 'connections';
      if (!state.admin.loaded) loadAdminData();
      go('settings');
      return;
    }

    var dc = e.target.closest('[data-disconnect]');
    if (dc) { disconnect(dc.dataset.disconnect); return; }

    var acc = e.target.closest('[data-connect-accept]');
    if (acc) {
      var bits = acc.dataset.connectAccept.split('|');
      acceptConnection(bits[0], bits[1], bits.slice(2).join('|'));
      return;
    }

    var lk = e.target.closest('[data-link-eid]');
    if (lk) { linkModal(lk.dataset.linkEid, lk.dataset.linkName); return; }
    var conn = e.target.closest('[data-connect]');
    if (conn) { connectModal(conn.dataset.connect, conn.dataset.connectKind || 'timeoff'); return; }
    var ptab = e.target.closest('[data-payroll-tab]');
    if (ptab) {
      state.payroll.tab = ptab.dataset.payrollTab;
      state.query = '';
      render();
      if (state.payroll.tab === 'hours' && !state.payroll.periods.length) loadPayrollIndex();
      return;
    }
    if (e.target.closest('[data-cov-now]')) { state.coverage.asOf = new Date(); render(); return; }
    if (e.target.closest('[data-cov-clear]')) {
      if (!confirm('Clear the loaded schedule and on-premise files?')) return;
      state.coverage.presence = null;
      state.coverage.presenceFile = '';
      state.coverage.asOf = null;
      try { sessionStorage.removeItem(SCHED_CACHE); } catch (err) { /* nothing cached */ }
      render();
      return;
    }

    if (e.target.closest('[data-review-exit]')) {
      state.coverage.reviewDate = '';
      state.coverage.reviewId = '';
      state.coverage.reviewDay = null;
      render();
      return;
    }
    if (e.target.closest('[data-export-toggle]')) {
      state.coverage.exportOpen = !state.coverage.exportOpen;
      render();
      return;
    }
    var copy = e.target.closest('[data-copy-sheet]');
    if (copy) {
      var resx = buildCoverageResult();
      if (!resx) return;
      var exx = ScheduleCore.spreadsheetExport(resx, {
        location: state.coverage.exportLoc, shift: state.coverage.exportShift,
        profiles: state.profiles,
        documented: (state.coverage.storedDay && state.coverage.storedDay.documented) || {}
      });
      navigator.clipboard.writeText(ScheduleCore.toTsv(exx, false)).then(function () {
        copy.textContent = 'Copied ' + exx.rows.length + ' rows';
      }).catch(function () { alert('Could not copy to the clipboard.'); });
      return;
    }
    var reqEx = e.target.closest('[data-req-expand]');
    if (reqEx && !e.target.closest('[data-profile]')) {
      var rid = reqEx.dataset.reqExpand;
      if (state.reqExpanded[rid]) delete state.reqExpanded[rid]; else state.reqExpanded[rid] = true;
      render();
      return;
    }
    if (e.target.closest('[data-req-save]')) { saveReqImport(); return; }
    if (e.target.closest('[data-req-sites]')) { saveSiteLessons(); return; }
    if (e.target.closest('[data-req-clear]')) {
      state.reqSources = []; state.reqImport = null; render(); return;
    }

    var fill = e.target.closest('[data-fill]');
    if (fill) {
      var r = state.stores.requisitions.find(function (x) { return x.id === fill.dataset.fill; });
      if (!r) return;
      var openings = Number(r.openings || 0), filled = Math.min(openings, Number(r.filled || 0) + 1);
      persist('requisitions', { id: r.id, filled: filled, status: filled >= openings && openings > 0 ? 'Filled' : 'Open' }, 'requisitions');
    }
  });

  // Documenting an absence: the disposition saves immediately, the free-text
  // reason debounces so it is not one write per keystroke.
  var docTimers = {};
  function saveDoc(el) {
    var date = state.coverage.reviewDate || ScheduleCore.isoDate(coverageAsOf());
    var key = el.dataset.docKey;
    var row = el.closest('.cov-doc');
    var rec = {
      key: key,
      name: el.dataset.docName || '',
      badge: el.dataset.docBadge || '',
      disposition: row.querySelector('.cov-disp').value,
      reason: row.querySelector('.cov-reason').value
    };
    return SuiteData.saveDocumentation(date, rec).then(function () {
      return taskFromDisposition(rec, date);
    }).then(function () {
      return SuiteData.loadCoverage(date);
    }).then(function (day) {
      if (state.coverage.reviewDate === date) state.coverage.reviewDay = day;
      else state.coverage.storedDay = day;
    }).catch(function (err) {
      console.warn('Could not save the documentation.', err);
      alert('That note could not be saved, so it was not shared with anyone else.\n\n' + err.message);
    });
  }
  /* Some dispositions are not just a note about today, they are a job for
     somebody: an assignment that has to be ended in RC and Beeline. Noticing it
     on the floor and recording it should not depend on the person also
     remembering to raise it somewhere else.

     The id is derived from the person and the day, so re-picking the disposition
     updates the one task rather than growing a pile of them -- and switching
     away from Terminated does NOT delete it, because by then somebody may
     already be working it. */
  var DISPOSITION_TASKS = {
    'Terminated': { kind: 'terminate', verb: 'End the assignment for' }
  };
  function taskFromDisposition(rec, date) {
    var spec = DISPOSITION_TASKS[rec.disposition];
    if (!spec) return Promise.resolve();
    var id = TasksCore.idFor(spec.kind, rec.key + ':' + date);
    if ((state.stores.tasks || []).some(function (t) { return t.id === id; })) return Promise.resolve();
    var p = rec.badge ? profile(rec.badge) : null;
    var task = TasksCore.create({
      id: id, kind: spec.kind,
      title: spec.verb + ' ' + (p ? p.name : rec.name || rec.badge || 'this associate'),
      detail: 'Marked ' + rec.disposition + ' on the on-premise check for ' + date +
        (rec.reason ? ' — ' + rec.reason : '') + '. Ends in RC and Beeline both.',
      badge: rec.badge || '', name: p ? p.name : (rec.name || ''),
      market: p ? (p.market || '') : '', location: p ? (p.locationLabel || '') : '',
      source: 'On-premise check', sourceKind: 'coverage', sourceId: rec.key
    }, currentActor(false), new Date());
    return SuiteData.saveRecord('tasks', task).then(function () {
      return SuiteData.loadCollection('tasks');
    }).then(function (rows) { state.stores.tasks = rows; }).catch(function (err) {
      // The documentation itself already saved; say what did not follow.
      console.warn('Could not raise the follow-up task.', err);
      alert('The note was saved, but the follow-up task could not be raised.\n\n' + err.message);
    });
  }

  root.addEventListener('change', function (e) {
    if (e.target.dataset && e.target.dataset.userRole) {
      persistAdmin('users', { id: e.target.dataset.userRole, email: e.target.dataset.userRole, role: e.target.value });
      return;
    }
    var ac = e.target.dataset && e.target.dataset.appConfig;
    if (ac) {
      var meta = APP_SETTINGS.filter(function (f) { return f.key === ac; })[0];
      persistAdmin('appConfig', { id: 'CFG-' + ac, key: ac, value: e.target.value.trim(),
        label: meta ? meta.label : ac });
      return;
    }
    var lf = e.target.dataset && e.target.dataset.listField;
    if (lf) {
      var f = lf.split('|'), patch = { id: f[1] };
      patch[f[2]] = e.target.value;
      persistAdmin(f[0], patch);
      return;
    }
    var um = e.target.dataset && e.target.dataset.userMarkets;
    if (um) {
      // Blank means every market, which is why it is not a multi-select: an
      // empty selection reads as "none" to most people, and it means the opposite.
      var list = e.target.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      persistAdmin('users', { id: um, email: um, markets: list });
      return;
    }
    if (e.target.classList.contains('status-select')) {
      var kind = e.target.dataset.statusKind || 'timeoff';
      var pipe = PIPELINES[kind];
      var local = LOCAL_OF[kind];
      var id = e.target.dataset.status;
      var rec = (state.stores[local] || []).filter(function (x) { return x.id === id; })[0];
      if (!rec || !pipe) return;
      var actor = currentActor(true);
      if (!actor) { render(); return; }   // they cancelled the name prompt
      var patch = pipe.applyStatus(rec, e.target.value, actor);
      // A task's ageing runs off updatedAt, so touching one has to move it --
      // otherwise working a task would not stop it escalating.
      if (kind === 'tasks') patch.updatedAt = patch.statusUpdatedAt;
      persist(kind, patch, local);
      return;
    }
    if (e.target.id === 'payroll-week') { openPayrollWeek(e.target.value); return; }
    if (e.target.id === 'payroll-close') {
      var week = state.payroll.week;
      if (!week) return;
      var iso = e.target.value ? new Date(e.target.value).toISOString() : '';
      SuiteData.savePayrollClose(week, iso).then(function () {
        return SuiteData.loadPayrollPeriod(week);
      }).then(function (period) {
        state.payroll.period = period;
        render();
      }).catch(function (err) { alert('That close date could not be saved.\n\n' + err.message); });
      return;
    }
    if (e.target.id === 'review-date') {
      var date = e.target.value;
      state.coverage.reviewDate = date;
      state.coverage.reviewId = '';
      state.coverage.reviewDay = null;
      if (!date) { render(); return; }
      SuiteData.loadCoverage(date).then(function (day) {
        state.coverage.reviewDay = day;
        var checks = (day && day.checks) || [];
        state.coverage.reviewId = checks.length ? checks[checks.length - 1].id : '';
        render();
      });
      render();
      return;
    }
    if (e.target.id === 'review-check') { state.coverage.reviewId = e.target.value; render(); return; }
    if (e.target.id === 'export-loc') { state.coverage.exportLoc = e.target.value; render(); return; }
    if (e.target.id === 'export-shift') { state.coverage.exportShift = e.target.value; render(); return; }
    if (!e.target.classList.contains('cov-disp')) return;
    // Re-render so the offered occurrence matches the new disposition.
    saveDoc(e.target).then(render);
  });
  root.addEventListener('input', function (e) {
    if (!e.target.classList.contains('cov-reason')) return;
    var el = e.target, key = el.dataset.docKey;
    clearTimeout(docTimers[key]);
    docTimers[key] = setTimeout(function () { saveDoc(el); }, 700);
  });

  root.addEventListener('input', function (e) {
    if (e.target.id !== 'suite-search') return;
    state.query = e.target.value;
    render();
    var i = document.getElementById('suite-search');
    if (i) { i.focus(); i.setSelectionRange(state.query.length, state.query.length); }
  });
  root.addEventListener('change', function (e) {
    if (e.target.id === 'market-picker') { setMarket(e.target.value); }
    if (e.target.id === 'status-filter') { state.statusFilter = e.target.value; render(); }

    var cov = e.target.closest('[data-cov]');
    if (cov && cov.files && cov.files[0]) {
      if (cov.dataset.cov === 'workbook') { readPlxUpload(cov.files[0]); return; }
      readCoverageFile(cov.files[0]);
      return;
    }
    var book = e.target.closest('[data-shift-book]');
    if (book && book.files && book.files[0]) { readShiftWorkbook(book.files[0]); return; }

    var ptoBook = e.target.closest('[data-pto-book]');
    if (ptoBook && ptoBook.files && ptoBook.files[0]) { readPtoTracker(ptoBook.files[0]); return; }

    var reqFile = e.target.closest('[data-req-file]');
    if (reqFile && reqFile.files && reqFile.files[0]) { readReqExport(reqFile.files[0]); return; }
    if (e.target.id === 'req-health') { state.reqHealth = e.target.value; render(); return; }
    if (e.target.id === 'req-site') { state.reqSite = e.target.value; render(); return; }
    if (e.target.id === 'req-when') { state.reqWhen = e.target.value; render(); return; }
    if (e.target.id === 'task-kind') { state.tasks.kind = e.target.value; render(); }
    if (e.target.id === 'task-done') { state.tasks.showDone = e.target.checked; render(); }
    if (e.target.id === 'cov-status') { state.coverage.statusFilter = e.target.value; render(); }
    if (e.target.id === 'cov-loc') { state.coverage.location = e.target.value; render(); }
    if (e.target.id === 'cov-grace') {
      var g = Number(e.target.value);
      state.coverage.grace = isFinite(g) && g >= 0 ? g : ScheduleCore.GRACE_MINUTES;
      render();
    }
    if (e.target.id === 'cov-asof') {
      var d = new Date(e.target.value);
      if (!isNaN(d.getTime())) { state.coverage.asOf = d; render(); }
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target.id !== 'connect-search') return;
    state.connectQuery = e.target.value;
    var box = document.getElementById('connect-results');
    if (box) box.innerHTML = connectResults();     // only the list, so focus is kept
  });
  document.addEventListener('click', function (e) {
    var hit = e.target.closest('[data-connect-to]');
    if (hit) {
      var kind = state.connectKind || 'timeoff';
      if (kind === 'timeclock') {
        var actor = currentActor(true);
        if (!actor) return;
        var target = profile(hit.dataset.connectTo);
        var modalEl = document.getElementById('suite-modal');
        if (modalEl) modalEl.remove();
        var eid = state.connectFor;
        SuiteData.saveRecord('timeclockLinks', {
          id: 'TCL-' + eid.replace(/[^A-Za-z0-9_-]/g, ''),
          eid: eid, badge: hit.dataset.connectTo,
          name: state.connectQuery, rosterName: target ? target.name : '',
          linkedBy: actor.name, linkedAt: new Date().toISOString()
        }).then(function () {
          return SuiteData.loadCollection('timeclockLinks');
        }).then(function (rows) {
          state.stores.timeclockLinks = rows;
          // Without this the profiles keep their old timeclock ids, so the person
          // you just connected stays on the unconnected list and the save looks
          // exactly like a failure.
          rebuild();
          render();
        }).catch(function (err) {
          alert('That connection could not be saved.\n\n' + err.message);
        });
        return;
      }
      var local = LOCAL_OF[kind], pipe = PIPELINES[kind];
      var rec = (state.stores[local] || []).filter(function (x) { return x.id === state.connectFor; })[0];
      if (!rec || !pipe) return;
      var actor = currentActor(true);
      if (!actor) return;
      var modal = document.getElementById('suite-modal');
      if (modal) modal.remove();
      persist(kind, pipe.applyConnection(rec, hit.dataset.connectTo, actor), local);
      return;
    }
    if (e.target.closest('[data-close]')) {
      var m = e.target.closest('.suite-modal-backdrop');
      if (m) m.remove();
    }
  });
  document.addEventListener('submit', function (e) {
    var form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    var type = form.dataset.form, data = Object.fromEntries(new FormData(form));
    ['minutes', 'points', 'hours', 'openings', 'filled'].forEach(function (k) {
      if (k in data) data[k] = Number(data[k]) || 0;
    });
    if (data.badge) {
      /* Whatever number somebody typed -- EID, badge, timeclock id -- is turned
         into the badge records are keyed by. The EID is tried first because it
         is what the team works from; nothing is saved against a key that
         reaches no profile without saying so first. */
      var who = findByAnyId(data.badge);
      if (who) {
        data.badge = who.badge;
      } else {
        data.badge = SuiteData.normBadge(data.badge);
        if (!confirm('"' + data.badge + '" does not match any EID, badge, or timeclock id on the ' +
          'current roster, so this record will not show on any profile. Save it anyway?')) return;
      }
    }
    if (type === 'requisitions' || type === 'requisition') {
      type = 'requisitions';
      data.status = data.openings > 0 && data.filled >= data.openings ? 'Filled' : 'Open';
    }
    if (type === 'task') {
      if (!String(data.title || '').trim()) { alert('A task needs a description of what has to be done.'); return; }
      // The select shows labels; the record stores the key.
      var picked = TasksCore.KINDS.filter(function (k) { return k.label === data.kind; })[0];
      data.kind = picked ? picked.key : TasksCore.DEFAULT_KIND;
      var p = data.badge ? profile(data.badge) : null;
      if (p) { data.name = p.name; data.market = p.market || ''; data.location = p.locationLabel || ''; }
      type = 'tasks';
      data = TasksCore.create(data, currentActor(true) || null, new Date());
    }
    if (!data.id) data.id = type.slice(0, 2).toUpperCase() + Date.now();
    document.getElementById('suite-modal').remove();
    persist(type, data, LOCAL_KEY[type]);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var m = document.getElementById('suite-modal');
    if (m) m.remove();
  });

  /* ---------- boot ---------- */
  // The roster arrives from the reconciliation view (index.html) whenever the
  // snapshot or a manual status override changes.
  document.addEventListener('geodis:records', function (e) {
    state.records = e.detail.records || [];
    state.notes = e.detail.notes || state.notes;
    state.updatedAt = e.detail.updatedAt || state.updatedAt;
    rebuild();
    render();
  });


  loadStoredCoverage();
  SuiteAuth.onChange(function (snap) {
    state.auth = snap;
    if (state.view === 'settings') render();
  });
  SuiteAuth.resume();

  SuiteData.loadIlPtoSync().then(function (sync) {
    state.ilPto.sync = sync || {};
    if (state.view === 'timeoff') render();
  });

  SuiteData.loadPlxSync().then(function (sync) {
    state.plx.sync = sync;
    if (state.view === 'reconciliation') render();
  });

  SuiteData.loadAll().then(function (stores) {
    state.stores = stores;
    state.storesLoaded = true;
    rebuild();
    render();
  });

  window.GEODISSuite = {
    go: go,
    state: state,
    profile: profile,
    reload: function () {
      return SuiteData.loadAll().then(function (s) { state.stores = s; rebuild(); render(); });
    }
  };

  render();
})();
