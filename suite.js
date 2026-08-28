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
     or early-out is half an absence. Editable on every entry -- these are the
     starting points so the common cases are one click.

     attendance-import.js MUST agree with this. The same occurrence cannot be
     worth more because it arrived by import than because somebody typed it. */
  var TYPE_POINTS = {
    'Present': 0, 'Late': 0.5, 'Early Out': 0.5, 'Absent': 1,
    'No Call / No Show': 2, 'Excused': 0
  };
  var TIME_OFF_TYPES = ['PTO', 'VTO', 'Sick', 'Personal', 'LOA'];
  /* How a documented absence is characterised. "Badge / system issue" matters
     most: it is the way to record that the person WAS here and the reader missed
     them, so a hardware gap never turns into a disciplinary record. */
  var DISPOSITIONS = ['', ScheduleCore.PRESENT_DISPOSITION, 'Called in', 'No call / no show',
    'Approved time off', 'Late arrival', 'Left early', 'Reassigned', 'Terminated',
    'Badge / system issue', 'Other'];
  // Disposition -> the occurrence a one-click log would create. null means the
  // absence is explained and no occurrence should be offered at all.
  var DISPOSITION_OCCURRENCE = {
    // They were here -- the reader saw a punch out, or missed the punch in.
    'Present': null,
    'Called in': { type: 'Absent', points: 1 },
    'No call / no show': { type: 'No Call / No Show', points: 2 },
    'Approved time off': null,
    'Late arrival': { type: 'Late', points: 0.5 },
    'Left early': { type: 'Early Out', points: 0.5 },
    'Reassigned': null,
    // Gone. Nobody accrues attendance points after they leave, and the empty
    // shift is a staffing problem rather than a disciplinary one.
    'Terminated': null,
    'Badge / system issue': null,
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
    sort: { associates: { key: 'name', dir: 1 }, attendance: { key: 'date', dir: -1 } },
    market: (function () {
      try { return localStorage.getItem('badgeCrosscheck.market') || 'all'; } catch (e) { return 'all'; }
    })(),
    statusFilter: 'Active',
    records: null,          // null = snapshot has not arrived yet
    notes: {},              // shared badge -> note, published with the roster
    updatedAt: null,
    profiles: new Map(),
    tasks: { kind: 'all', showDone: false },
    stores: { attendance: [], timeOff: [], requisitions: [], performance: [], shifts: [], discrepancies: [], tasks: [],
      associatePto: [], locations: [], appConfig: [], timeclockLinks: [] },
    connectFor: '', connectQuery: '', connectKind: 'timeoff',
    payroll: { periods: [], week: '', period: null, tab: 'discrepancies', loading: false },
    plx: { sync: null, busy: false, note: '' },   // the live workbook from SharePoint
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
    if (state.auth.signedIn && state.auth.account) {
      var acct = state.auth.account;
      return PipelineCore.actorOf(acct.name || acct.email, acct.email, 'account');
    }
    var name = '';
    try { name = localStorage.getItem(ACTOR_KEY) || ''; } catch (e) { /* private mode */ }
    if (!name && promptIfMissing) {
      name = (window.prompt('Your name, so status changes can be attributed.\n\n' +
        'This is stored in this browser only, until sign-in is added.', '') || '').trim();
      if (!name) return null;
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
  function markets() {
    var set = new Set();
    allProfiles().forEach(function (p) { if (p.market) set.add(p.market); });
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
      return (p.name + ' ' + p.badge + ' ' + p.empNumber + ' ' + p.market).toLowerCase().indexOf(q) !== -1;
    });
  }

  /* ---------- shell ---------- */
  function icon(name) {
    return {
      overview: '<path d="M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-7H9v7H4a1 1 0 01-1-1z"/>',
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
    var add = '<button class="suite-add" data-add-task title="Raise a task">+' +
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
  function filters(placeholder) {
    return '<div class="filter-row"><input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="' + esc(placeholder || 'Search by name, badge, or employee #…') + '">' +
      '<select class="suite-select" id="status-filter">' +
      ['Active', 'Ended', 'all'].map(function (v) {
        return '<option value="' + v + '" ' + (state.statusFilter === v ? 'selected' : '') + '>' +
          (v === 'all' ? 'All statuses' : v) + '</option>';
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
  function rcBase() {
    var row = (state.stores.appConfig || []).filter(function (c) { return c.key === 'rcBaseUrl'; })[0];
    return row && row.value ? String(row.value).replace(/\/+$/, '') : '';
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
    return rcLink(p.assignmentId, (row && row.value) || 'Assignment__c', label || 'RC assignment');
  }

  function statusChip(p) {
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
    var reqs = requisitionsInMarket();
    var active = all.filter(function (p) { return p.status === 'Active'; });
    var exceptions = all.filter(function (p) { return !p.reconciled; }).length;
    var pending = timeOff.filter(function (t) { return TimeOffCore.needsAction(t.status); }).length;
    var open = reqs.filter(function (r) { return r.status !== 'Filled'; })
      .reduce(function (n, r) { return n + Math.max(0, Number(r.openings || 0) - Number(r.filled || 0)); }, 0);
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
      (reqs.length ? reqTable(reqs.slice(0, 5), true) : empty('No Beeline requests yet')) +
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
      '<th>Employee #</th>' +
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
          '<td>' + esc(p.empNumber || '—') + '</td>' +
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
      '<p>Badge ' + esc(p.badge) + (p.empNumber ? ' · Employee #' + esc(p.empNumber) : '') +
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
      '<div class="suite-actions"><button class="suite-btn primary" data-add="attendance" data-badge="' + esc(p.badge) + '">+ Log occurrence</button></div></div>' +
      (p.attendance.length ? '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
        '<th>Date</th><th>Type</th><th>Minutes</th><th>Points</th><th>Notes</th><th></th></tr></thead><tbody>' +
        p.attendance.map(function (a) {
          return '<tr><td>' + esc(a.date) + '</td><td>' + esc(a.type) + '</td><td>' + esc(a.minutes || 0) + '</td>' +
            '<td>' + esc(a.points || 0) + '</td><td class="detail-cell">' + esc(a.notes || '') + '</td>' +
            '<td><button class="suite-btn danger" data-del="attendance|' + esc(a.id) + '">Remove</button></td></tr>';
        }).join('') + '</tbody></table></div>' : empty('No occurrences logged')) + '</section>' +

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

  function covMetrics(s) {
    var cov = s.coverage == null ? '—' : s.coverage + '%';
    return '<div class="metric-strip">' +
      metric('Coverage now', cov, s.byStatus.working + ' of ' + s.onShift + ' on-shift associates present',
        s.coverage == null ? '' : s.coverage >= 90 ? 'green' : 'orange') +
      metric('Working', s.byStatus.working, 'On shift and on premise', 'green') +
      metric('Not clocked in', s.byStatus.missing, 'On shift, not on premise', s.byStatus.missing ? 'orange' : 'green') +
      metric('Unscheduled', s.byStatus.unscheduled, 'On premise with no shift covering now', s.byStatus.unscheduled ? 'orange' : 'green') +
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
    if (res.summary.noPresence) {
      notes.push(res.summary.noPresence + ' scheduled associate(s) are missing from the on-premise report entirely.');
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
      '" placeholder="Search by name, badge, employee id, or supervisor…">' +
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
      return (r.name + ' ' + r.badge + ' ' + r.wfmId + ' ' + r.manager + ' ' + r.job).toLowerCase().indexOf(q) !== -1;
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
      // Logging an occurrence is a policy call, so it is offered, never automatic.
      (occ && r.badge ? '<button class="suite-btn cov-log" data-log-badge="' + esc(r.badge) +
        '" data-log-type="' + esc(occ.type) + '" data-log-points="' + occ.points +
        '" data-log-reason="' + esc(doc.reason || doc.disposition) + '">Log ' + esc(occ.type) + '</button>' : '') +
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
      '" placeholder="Search by name, badge, employee id, or supervisor…">' +
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
              '<div class="sub">' + esc(r.badge ? 'Badge ' + r.badge : (r.wfmId || 'No employee id')) + '</div></td>' +
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
      '<th>Associate</th><th>Status</th><th>On premise</th><th>Scheduled shift</th>' +
      '<th>Location</th><th>Job</th><th>Supervisor</th><th>Documented</th></tr></thead><tbody>' +
      rows.slice(0, MAX_ROWS).map(function (r) {
        // Only a row that reached a roster profile can open one.
        var open = r.badge ? ' data-profile="' + esc(r.badge) + '"' : '';
        var nameCls = r.badge ? 'name link' : 'name';
        var sub = r.badge
          ? 'Badge ' + esc(r.badge) +
            (r.rosterMatch === 'name' ? ' · matched by name' : r.rosterMatch === 'linked' ? ' · connected by hand' : '')
          : '<b class="warn-text">Not connected</b> · ' + esc(r.wfmId || 'no timeclock id') +
            ' <button class="suite-btn tiny" data-link-eid="' + esc(r.wfmId || '') +
            '" data-link-name="' + esc(r.name) + '">Connect…</button>';
        return '<tr class="cov-row ' + r.severity + '">' +
          '<td><div class="' + nameCls + '"' + open + '>' + esc(r.name) + '</div><div class="sub">' + sub +
          (r.inSchedule ? '' : ' · no schedule row') + (r.ambiguous ? ' · duplicate name' : '') + '</div></td>' +
          '<td><span class="cov-status ' + r.severity + '">' + esc(r.statusLabel) + '</span></td>' +
          '<td>' + (r.present ? '<span class="cov-dot on">Yes</span>' : '<span class="cov-dot off">No</span>') + '</td>' +
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

  /* ---------- attendance ---------- */
  function attendance() {
    if (!state.records) return needsRoster();
    if (!state.storesLoaded) return loadingPanel('attendance records');
    var q = state.query.trim().toLowerCase();
    var all = state.stores.attendance.filter(function (a) {
      var p = profile(a.badge);
      if (!inMarket(p)) return false;
      if (!q) return true;
      return ((p ? p.name : '') + ' ' + a.badge + ' ' + a.type + ' ' + a.date).toLowerCase().indexOf(q) !== -1;
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

    return hero('Attendance', 'Occurrences and points, joined to the assignment roster by badge.', 'attendance', 'Log occurrence') +
      (orphans.length ? '<div class="warn-banner"><b>' + orphans.length + '</b> attendance record' +
        (orphans.length === 1 ? '' : 's') + ' could not be matched to a badge on the roster and are not counted in any profile.</div>' : '') +
      '<section class="suite-panel">' +
      '<div class="filter-row"><input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="Search by name, badge, type, or date…"></div>' +
      (rows.length ? '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
        sortHead('attendance', 'date', 'Date') +
        sortHead('attendance', 'name', 'Associate') +
        sortHead('attendance', 'location', 'Site / account') +
        sortHead('attendance', 'type', 'Type') +
        '<th>Minutes</th>' + sortHead('attendance', 'points', 'Points') +
        '<th>Running pts</th><th>Notes</th><th></th></tr></thead><tbody>' +
        rows.map(function (a) {
          var p = profile(a.badge);
          return '<tr><td>' + esc(a.date) + '</td>' +
            '<td>' + (p ? '<div class="name link" data-profile="' + esc(p.badge) + '">' + esc(p.name) + '</div><div class="sub">' + esc(p.badge) + '</div>'
              : '<div class="name">Badge ' + esc(a.badge) + '</div><div class="sub warn-text">Not on roster</div>') + '</td>' +
            '<td>' + (p && p.location
              ? esc(p.location) + (p.account ? ' <span class="sub">' + esc(p.account) + '</span>' : '')
              : '<span class="sub">—</span>') + '</td>' +
            '<td>' + esc(a.type) + '</td><td>' + esc(a.minutes || 0) + '</td><td>' + esc(a.points || 0) + '</td>' +
            '<td>' + (p ? p.points : '—') + '</td><td class="detail-cell">' + esc(a.notes || '') + '</td>' +
            '<td><button class="suite-btn danger" data-del="attendance|' + esc(a.id) + '">Remove</button></td></tr>';
        }).join('') + '</tbody></table></div>' + rowCap(rows.length, all.length)
        : empty('No attendance records', 'Log an occurrence, or import the daily attendance report.')) +
      '</section>';
  }

  /* ---------- time off ---------- */
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
      return ((p ? p.name : t.name || '') + ' ' + t.badge + ' ' + t.type + ' ' +
        t.status + ' ' + (t.source || '')).toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return String(b.start || '').localeCompare(String(a.start || '')); });
    var rows = all.slice(0, MAX_ROWS);

    var orphans = state.stores.timeOff.filter(function (t) { return !profile(t.badge); });
    return hero('PTO / VTO tracking', 'Approved time off is excused and carries no attendance points.', 'timeoff', 'New request') +
      (orphans.length ? '<div class="warn-banner"><b>' + orphans.length + '</b> request' +
        (orphans.length === 1 ? '' : 's') + ' could not be matched to an associate on the roster — usually a ' +
        'name typed differently on the form. They are listed below and still need actioning.</div>' : '') +
      '<section class="suite-panel">' +
      '<div class="filter-row"><input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="Search by name, badge, type, or status…"></div>' +
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
      '" placeholder="Search by name or badge…" autofocus>' +
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
      '" placeholder="Search by name or badge…" autofocus>' +
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
      return (p.name + ' ' + p.badge + ' ' + p.empNumber + ' ' + p.market).toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return a.name.localeCompare(b.name); }).slice(0, 25);
    if (!hits.length) return '<div class="connect-hint">No associate matches “' + esc(q) + '”.</div>';
    return hits.map(function (p) {
      return '<button class="connect-hit" data-connect-to="' + esc(p.badge) + '">' +
        '<div class="initial">' + esc(p.initials) + '</div>' +
        '<div><div class="name">' + esc(p.name) + '</div>' +
        '<div class="sub">' + esc(p.badge) + ' · ' + esc(p.market) +
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
      return (t.title + ' ' + t.detail + ' ' + t.name + ' ' + t.badge).toLowerCase().indexOf(q) !== -1;
    }), now);

    return hero('Tasks', 'Everything outstanding, from wherever it was raised. A task stays until somebody marks it complete.', 'task', 'Raise a task') +
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
      '" placeholder="Search by title, detail, name, or badge…">' +
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
                    '<div class="sub">' + esc(p.badge) + '</div>'
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
      return ((p ? p.name : dsc.name || '') + ' ' + dsc.badge + ' ' + dsc.location + ' ' +
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
      '" placeholder="Search by name, location, detail, or status…"></div>' +
      (rows.length ? '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
        '<th>Associate</th><th>Location</th><th>Date</th><th>Week ending</th><th>Details</th>' +
        '<th>Status</th><th></th></tr></thead><tbody>' +
        rows.map(function (dsc) {
          var p = profile(dsc.badge);
          return '<tr' + (p ? '' : ' class="cov-row warn"') + '><td>' +
            (p ? '<div class="name link" data-profile="' + esc(p.badge) + '">' + esc(p.name) + '</div>' +
                 '<div class="sub">' + esc(p.badge) + '</div>'
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
            '<div class="sub">' + esc(c.badge) + '</div></td>' +
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
      ['shifts', 'Shifts'], ['links', 'RC links']];
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
        : state.admin.tab === 'links' ? appConfigPanel(admin)
        : listPanel('shiftTypes', admin));
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
      hint: 'e.g. https://yourorg.lightning.force.com — blank shows no links' },
    { key: 'rcAssignmentObject', label: 'RC assignment object API name',
      hint: 'e.g. Assignment__c. Only needed for assignment links.' }
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
  function requisitions() {
    if (!state.storesLoaded) return loadingPanel('requisitions');
    var q = state.query.trim().toLowerCase();
    var rows = requisitionsInMarket().filter(function (r) {
      if (!q) return true;
      return (r.id + ' ' + r.title + ' ' + r.department + ' ' + r.shift + ' ' + r.priority + ' ' + r.status).toLowerCase().indexOf(q) !== -1;
    });
    return hero('Beeline Requests', 'Hiring demand from opening through fulfillment.', 'requisition', 'New request') +
      '<section class="suite-panel">' +
      '<div class="filter-row"><input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="Search requisitions…"></div>' +
      (rows.length ? reqTable(rows, false) : empty('No Beeline requests yet')) + '</section>';
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

  /* The live PLX workbook lives in SharePoint, which the browser cannot read --
     different origin, and it needs Microsoft 365 auth this tool does not have.
     Power Automate pushes it here instead, so this button asks for a fresh pull
     and then reloads. When no on-demand flow is configured it still reloads
     whatever was last pushed, and says which of the two just happened. */
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
        : '<span class="warn-text">The PLX workbook has never arrived from SharePoint. ' +
          'Check the flow run history — a 401 there means its SharePoint connection needs reauthorising.</span>') +
      (p.note ? '<span class="plx-note">' + esc(p.note) + '</span>' : '') +
      '</div>' +
      '<button class="suite-btn primary" data-plx-refresh ' + (p.busy ? 'disabled' : '') + '>' +
      (p.busy ? 'Refreshing…' : 'Refresh from SharePoint') + '</button></section>' +
      (sync && sync.warnings && sync.warnings.length
        ? '<div class="warn-banner cov-warn"><strong>From the last workbook</strong><ul>' +
          sync.warnings.slice(0, 6).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') +
          (sync.warnings.length > 6 ? '<li>…and ' + (sync.warnings.length - 6) + ' more.</li>' : '') +
          '</ul></div>'
        : '');
  }

  function refreshPlx() {
    if (state.plx.busy) return;
    state.plx.busy = true;
    state.plx.note = '';
    render();
    var before = state.plx.sync && state.plx.sync.syncedAt;
    SuiteData.requestPlxRefresh().then(function (r) {
      // A triggered pull takes a moment to come back, so give the flow a beat
      // before reading, then say plainly whether anything actually moved.
      var wait = r && r.triggered ? 4000 : 0;
      return new Promise(function (done) { setTimeout(done, wait); }).then(function () {
        return SuiteData.loadPlxSync();
      }).then(function (sync) {
        state.plx.sync = sync;
        if (r && r.triggered) {
          state.plx.note = sync.syncedAt && sync.syncedAt !== before
            ? 'Pulled a fresh copy just now.'
            : 'Asked SharePoint for a fresh copy; it has not landed yet. Refresh again in a moment.';
        } else {
          state.plx.note = (r && r.message) || 'Reloaded the last workbook that was pushed.';
        }
        return SuiteData.loadCollection('shifts');
      }).then(function (shifts) {
        state.stores.shifts = shifts;
        return SuiteData.loadCollection('requisitions');
      }).then(function (reqs) {
        state.stores.requisitions = reqs;
        rebuild();
      });
    }).catch(function (err) {
      state.plx.note = 'Could not refresh: ' + err.message;
    }).then(function () {
      state.plx.busy = false;
      render();
    });
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
  function rosterDatalist() {
    return '<datalist id="roster-list">' + allProfiles().slice(0, 2000).map(function (p) {
      return '<option value="' + esc(p.badge) + '">' + esc(p.name) + ' · ' + esc(p.market) + '</option>';
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
        (type === 'badge' ? ' required' : '') + ' placeholder="Badge number">' + rosterDatalist();
    } else {
      input = '<input name="' + name + '" type="' + type + '" value="' + esc(value) + '"' +
        (type === 'number' ? ' min="0" step="0.5"' : '') + '>';
    }
    return '<label class="suite-field"><span>' + esc(label) + '</span>' + input + '</label>';
  }
  function modal(type, badge) {
    var fields = '', title = '';
    if (type === 'attendance') {
      title = 'Log attendance occurrence';
      fields = field('Associate badge', 'badge', 'badge', badge || '') +
        field('Date', 'date', 'date', today()) +
        field('Type', 'type', 'select', 'Absent', Object.keys(TYPE_POINTS)) +
        field('Minutes', 'minutes', 'number', '0') +
        field('Policy points', 'points', 'number', '1') +
        field('Notes', 'notes', 'text', '');
    } else if (type === 'timeoff') {
      title = 'New time-off request';
      fields = field('Associate badge', 'badge', 'badge', badge || '') +
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
        field('Associate badge (optional)', 'badge', 'badge-optional', badge || '') +
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
  var LOCAL_KEY = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions',
    discrepancies: 'discrepancies', users: 'users', locations: 'locations', shiftTypes: 'shiftTypes',
    appConfig: 'appConfig', tasks: 'tasks' };

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
    var lk = e.target.closest('[data-link-eid]');
    if (lk) { linkModal(lk.dataset.linkEid, lk.dataset.linkName); return; }
    var conn = e.target.closest('[data-connect]');
    if (conn) { connectModal(conn.dataset.connect, conn.dataset.connectKind || 'timeoff'); return; }
    if (e.target.closest('[data-plx-refresh]')) { refreshPlx(); return; }
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
    var log = e.target.closest('[data-log-badge]');
    if (log) {
      var d = log.dataset;
      persist('attendance', {
        id: 'AT' + Date.now(), badge: d.logBadge,
        date: ScheduleCore.isoDate(coverageAsOf()),
        type: d.logType, minutes: 0, points: Number(d.logPoints),
        notes: d.logReason || 'From shift coverage'
      }, 'attendance');
      return;
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

  // Picking an attendance type fills in that type's default point value.
  document.addEventListener('change', function (e) {
    if (!e.target.closest('[data-form="attendance"]') || e.target.name !== 'type') return;
    var pts = e.target.form.querySelector('[name="points"]');
    if (pts) pts.value = TYPE_POINTS[e.target.value];
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
      data.badge = SuiteData.normBadge(data.badge);
      if (!profile(data.badge) && !confirm('Badge ' + data.badge + ' is not on the current roster, so this record will not show on any profile. Save it anyway?')) return;
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
