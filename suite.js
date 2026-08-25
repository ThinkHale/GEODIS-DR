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

  // Default occurrence value per attendance type. Editable on every entry --
  // these are just the starting points so the common cases are one click.
  var TYPE_POINTS = {
    'Present': 0, 'Late': 0.5, 'Early Out': 0.5, 'Absent': 1,
    'No Call / No Show': 2, 'Excused': 0
  };
  var TIME_OFF_TYPES = ['PTO', 'VTO', 'Sick', 'Personal', 'LOA'];
  var NAV = [
    ['overview', 'Overview'], ['associates', 'Associates'], ['coverage', 'Coverage'],
    ['attendance', 'Attendance'], ['timeoff', 'Time Off'], ['requisitions', 'Requisitions'],
    ['reconciliation', 'Assignment Reconciliation']
  ];

  var state = {
    view: new URLSearchParams(location.search).get('view') || 'overview',
    profileBadge: null,
    query: '',
    market: 'all',
    statusFilter: 'Active',
    records: null,          // null = snapshot has not arrived yet
    notes: {},              // shared badge -> note, published with the roster
    updatedAt: null,
    profiles: new Map(),
    stores: { attendance: [], timeOff: [], requisitions: [], performance: [] },
    storesLoaded: false,
    // Coverage inputs are uploaded reports, not shared collections: the schedule
    // lands weekly, the on-premise snapshot several times a day.
    coverage: {
      schedule: null, presence: null,
      scheduleFile: '', presenceFile: '',
      asOf: null, grace: ScheduleCore.GRACE_MINUTES,
      statusFilter: 'exceptions', location: 'all'
    }
  };

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
      notes: state.notes
    });
  }
  function allProfiles() { return Array.from(state.profiles.values()); }
  function profile(badge) { return state.profiles.get(SuiteData.normBadge(badge)) || null; }
  function markets() {
    var set = new Set();
    allProfiles().forEach(function (p) { if (p.market) set.add(p.market); });
    return Array.from(set).sort();
  }
  // The roster subset the module tabs operate on: market, status, then search.
  function roster() {
    var q = state.query.trim().toLowerCase();
    return allProfiles().filter(function (p) {
      if (state.market !== 'all' && p.market !== state.market) return false;
      if (state.statusFilter !== 'all' && p.status !== state.statusFilter) return false;
      if (!q) return true;
      return (p.name + ' ' + p.badge + ' ' + p.empNumber + ' ' + p.market).toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  /* ---------- shell ---------- */
  function icon(name) {
    return {
      overview: '<path d="M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-7H9v7H4a1 1 0 01-1-1z"/>',
      associates: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>',
      coverage: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
      attendance: '<rect x="3" y="5" width="18" height="16" rx="1"/><path d="M8 3v4m8-4v4M3 10h18m-13 5l2 2 5-5"/>',
      timeoff: '<path d="M3 12a9 9 0 0118 0H3zm9 0v9m-4 0h8"/>',
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
      associates: ['Associates', 'Roster, scorecards, and profile detail'],
      profile: ['Associate Profile', 'Assignment, attendance, time off, and performance'],
      coverage: ['Coverage', 'Scheduled shifts vs. who is actually on premise'],
      attendance: ['Attendance', 'Occurrences and points'],
      timeoff: ['Time Off', 'PTO and VTO tracking'],
      requisitions: ['Requisitions', 'Staffing demand and fulfillment'],
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
    return '<header class="suite-top"><div class="suite-heading"><h1>' + esc(x[0]) + '</h1><p>' + esc(x[1]) + '</p></div>' +
      picker + '<div class="suite-user"><span><b>Operations</b></span><div class="suite-avatar">OP</div></div></header>';
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
    var all = allProfiles();
    var active = all.filter(function (p) { return p.status === 'Active'; });
    var exceptions = all.filter(function (p) { return !p.reconciled; }).length;
    var pending = state.stores.timeOff.filter(function (t) { return t.status === 'Pending'; }).length;
    var open = state.stores.requisitions.filter(function (r) { return r.status !== 'Filled'; })
      .reduce(function (n, r) { return n + Math.max(0, Number(r.openings || 0) - Number(r.filled || 0)); }, 0);
    var atRisk = all.filter(function (p) { return p.points >= 5; }).length;

    var t = trend();
    return '<div class="metric-strip">' +
      metric('Active associates', active.length, all.length + ' on the assignment roster') +
      metric('Attendance rate', t.latest == null ? '—' : t.latest + '%', t.latest == null ? 'No attendance data yet' : t.latestNote, 'green') +
      metric('PTO / VTO pending', pending, 'Requests needing review') +
      metric('Reconciliation exceptions', exceptions, 'Profiles out of sync', 'orange') +
      '</div><div class="suite-grid"><div class="suite-stack">' +
      '<section class="suite-panel"><div class="suite-panel-head"><h2>Attendance rate trend</h2>' +
      '<div class="suite-actions"><button class="suite-btn" data-nav="attendance">View report</button></div></div>' +
      t.html + '</section>' +
      '<section class="suite-panel"><div class="suite-panel-head"><h2>Staffing &amp; requisition coverage</h2>' +
      '<div class="suite-actions"><button class="suite-btn" data-nav="requisitions">View requisitions</button></div></div>' +
      (state.stores.requisitions.length ? reqTable(state.stores.requisitions.slice(0, 5), true) : empty('No requisitions yet')) +
      '</section></div><div class="suite-stack">' +
      '<section class="suite-panel"><div class="suite-panel-head"><h2>Time off activity</h2>' +
      '<div class="suite-actions"><button class="suite-btn" data-nav="timeoff">View all</button></div></div>' +
      (state.stores.timeOff.length ? state.stores.timeOff.slice(0, 6).map(activityRow).join('') : empty('No time-off activity')) +
      '</section><section class="suite-panel"><div class="suite-panel-head"><h2>Operational action queue</h2></div>' +
      alertRow(exceptions, 'Assignment reconciliation exceptions', 'reconciliation') +
      alertRow(pending, 'Pending time-off approvals', 'timeoff') +
      alertRow(open, 'Unfilled requisition positions', 'requisitions') +
      alertRow(atRisk, 'Associates at 5+ attendance points', 'attendance') +
      '</section></div></div>';
  }

  /* Real 7-day attendance rate, computed from logged occurrences. "Rate" is the
     share of that day's records that were not an absence or no-call. With no
     attendance data the panel says so rather than drawing an invented line. */
  function trend() {
    var days = [], any = false;
    for (var i = 6; i >= 0; i--) {
      var date = daysBack(i);
      var rows = state.stores.attendance.filter(function (a) { return a.date === date; });
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
      ' · ' + esc(t.hours || 0) + ' hours · ' + esc(t.status || '') + '</div></div>' +
      '<div class="row-type ' + (t.type === 'VTO' ? 'vto' : t.type === 'Sick' ? 'sick' : '') + '">' + esc(t.type) + '</div></div>';
  }
  function alertRow(n, label, nav) {
    return '<div class="alert-row" data-nav="' + nav + '"><div class="alert-num">' + n + '</div>' +
      '<div class="row-title">' + esc(label) + '</div><span>›</span></div>';
  }

  /* ---------- associates ---------- */
  function associates() {
    if (!state.records) return needsRoster();
    var all = roster(), rows = all.slice(0, MAX_ROWS);
    return hero('Associate roster', 'Built from the RC / Beeline assignment snapshot. Profiles cannot be added by hand — a profile exists because an assignment does.', '', '') +
      '<section class="suite-panel">' + filters() +
      '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
      '<th>Associate</th><th>Employee #</th><th>Market</th><th>Status</th><th>Reconciliation</th>' +
      '<th>Attendance pts</th><th>Standing</th><th>Score</th><th></th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (p) {
        return '<tr><td><div class="name">' + esc(p.name || 'Unknown') + '</div>' +
          '<div class="sub">' + esc(p.badge) + (p.dup ? ' · <b class="dup-flag">DUP</b>' : '') + '</div></td>' +
          '<td>' + esc(p.empNumber || '—') + '</td>' +
          '<td>' + esc(p.market) + (p.marketRaw ? ' <span class="sub">· ' + esc(p.marketRaw) + '</span>' : '') + '</td>' +
          '<td>' + statusChip(p) + '</td><td>' + reconChip(p) + '</td>' +
          '<td>' + p.points + '</td><td><span class="standing ' + p.standingCls + '">' + esc(p.standing) + '</span></td>' +
          '<td>' + scoreCell(p) + '</td>' +
          '<td><button class="suite-btn" data-profile="' + esc(p.badge) + '">Open</button></td></tr>';
      }).join('') : '<tr><td colspan="9">' + empty('No associates match', 'Adjust the search, market, or status filter.') + '</td></tr>') +
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
      '<div class="profile-chips">' + statusChip(p) + reconChip(p) + '</div>' +
      '<button class="suite-btn" data-nav="associates">← Roster</button></div>' +

      '<div class="metric-strip">' +
      metric('Attendance points', p.points, p.standing, p.points >= 5 ? 'orange' : 'green') +
      metric('Performance score', p.score == null ? '—' : p.score, m ? 'Period ' + (m.period || 'current') : 'No performance record') +
      metric('Time-off requests', p.timeOff.length, p.timeOff.filter(function (t) { return t.status === 'Pending'; }).length + ' pending') +
      metric('Assignment', p.status, p.status === 'Ended' && p.endDate ? 'Ended ' + esc(p.endDate) : 'Per RC / Beeline snapshot') +
      '</div>' +

      '<div class="suite-grid"><div class="suite-stack">' +
      '<section class="suite-panel"><div class="suite-panel-head"><h2>Attendance history</h2>' +
      '<div class="suite-actions"><button class="suite-btn primary" data-add="attendance" data-badge="' + esc(p.badge) + '">+ Log occurrence</button></div></div>' +
      (p.attendance.length ? '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
        '<th>Date</th><th>Type</th><th>Minutes</th><th>Points</th><th>Notes</th><th></th></tr></thead><tbody>' +
        p.attendance.map(function (a) {
          return '<tr><td>' + esc(a.date) + '</td><td>' + esc(a.type) + '</td><td>' + esc(a.minutes || 0) + '</td>' +
            '<td>' + esc(a.points || 0) + '</td><td>' + esc(a.notes || '') + '</td>' +
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

      '<section class="suite-panel"><div class="suite-panel-head"><h2>Assignment &amp; reconciliation</h2></div>' +
      '<dl class="detail-list">' +
      detail('RC start', p.crmStart) + detail('Beeline start', p.beeStart) +
      detail('End date', p.endDate) + detail('End reason', p.endReason) +
      detail('Market', p.market + (p.marketVerified ? '' : ' (inferred)')) +
      detail('Recommended action', p.actionLabel) +
      detail('Reason', p.actionReason) +
      (p.newBadge ? detail('Replacement badge', p.newBadge) : '') +
      (p.note ? detail('Shared note', p.note) : '') +
      '</dl></section></div></div>';
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
     The weekly schedule is the plan; the on-premise export is the fact. Crossing
     them answers the question a supervisor actually asks at 11am: is the person who
     is supposed to be on the floor here?

     The two files move at different speeds -- the schedule lands once a week, the
     on-premise report is re-pulled several times a day -- so the parsed schedule is
     kept for the browser session and only the CSV has to be dropped again on the
     second and third pass. Session, not localStorage: a stale week's schedule must
     never quietly outlive its period. The period is checked against the as-of date
     as well, and reported when it does not cover it.

     All of the matching lives in schedule-core.js, the same way the Beeline/RC
     crosscheck lives in reconcile-core.js, so an automated import can reuse it
     without going through the DOM. */
  var SCHED_CACHE = 'geodis:schedule';

  function cacheSchedule(parsed, fileName) {
    try { sessionStorage.setItem(SCHED_CACHE, JSON.stringify({ parsed: parsed, fileName: fileName })); }
    catch (e) { /* private mode or quota: the schedule just will not survive a reload */ }
  }
  function restoreSchedule() {
    try {
      var raw = sessionStorage.getItem(SCHED_CACHE);
      if (!raw) return;
      var v = JSON.parse(raw);
      if (!v || !v.parsed || !Array.isArray(v.parsed.people) || !v.parsed.people.length) return;
      state.coverage.schedule = v.parsed;
      state.coverage.scheduleFile = v.fileName || '';
    } catch (e) { /* corrupt cache: start clean rather than render garbage */ }
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

  function buildCoverageResult() {
    var c = state.coverage;
    if (!c.schedule || !c.presence) return null;
    var res = ScheduleCore.buildCoverage({
      schedule: c.schedule, presence: c.presence,
      asOf: coverageAsOf(), graceMinutes: c.grace
    });
    // Reach from each row to its roster profile so a supervisor can go straight to
    // attendance and time off from an exception.
    ScheduleCore.linkRoster(res.rows, state.profiles, SuiteData.normBadge);
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

  function covSources() {
    var c = state.coverage;
    var schedMeta = '', presMeta = '';
    if (c.schedule) {
      schedMeta = c.schedule.people.length + ' associates · week of ' +
        (c.schedule.periodStart || '?') + ' to ' + (c.schedule.periodEnd || '?');
    }
    if (c.presence) {
      var on = c.presence.people.filter(function (p) { return p.present; }).length;
      presMeta = c.presence.people.length + ' associates · ' + on + ' on premise';
    }
    return '<div class="cov-sources">' +
      covDrop('schedule', 1, 'Weekly schedule',
        'The "Employee Schedule - Weekly" export (.xlsx). Load it once a week — it is kept for this browser session.',
        c.scheduleFile, schedMeta) +
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

  function covWarnings(res) {
    var c = state.coverage, notes = [];
    var day = ScheduleCore.isoDate(coverageAsOf());
    if (c.schedule && c.schedule.periodStart && (day < c.schedule.periodStart || day > c.schedule.periodEnd)) {
      notes.push('The loaded schedule covers ' + c.schedule.periodStart + ' to ' + c.schedule.periodEnd +
        ', which does not include ' + day + '. Load the current week before acting on this.');
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

  function covTable(rows, total) {
    return '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
      '<th>Associate</th><th>Status</th><th>On premise</th><th>Scheduled shift</th>' +
      '<th>Location</th><th>Job</th><th>Supervisor</th></tr></thead><tbody>' +
      rows.slice(0, MAX_ROWS).map(function (r) {
        // Only a row that reached a roster profile can open one.
        var open = r.badge ? ' data-profile="' + esc(r.badge) + '"' : '';
        var nameCls = r.badge ? 'name link' : 'name';
        var sub = r.badge
          ? 'Badge ' + esc(r.badge) + (r.rosterMatch === 'name' ? ' · matched by name' : '')
          : esc(r.wfmId || 'No employee id');
        return '<tr class="cov-row ' + r.severity + '">' +
          '<td><div class="' + nameCls + '"' + open + '>' + esc(r.name) + '</div><div class="sub">' + sub +
          (r.inSchedule ? '' : ' · no schedule row') + (r.ambiguous ? ' · duplicate name' : '') + '</div></td>' +
          '<td><span class="cov-status ' + r.severity + '">' + esc(r.statusLabel) + '</span></td>' +
          '<td>' + (r.present ? '<span class="cov-dot on">Yes</span>' : '<span class="cov-dot off">No</span>') + '</td>' +
          '<td>' + covShiftCell(r) + '</td>' +
          '<td>' + esc(locLeaf(r.location) || '—') + '</td>' +
          '<td>' + esc(r.job || '—') + '</td>' +
          '<td>' + esc(r.manager || '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>' + rowCap(Math.min(rows.length, MAX_ROWS), rows.length);
  }

  function coverageView() {
    var c = state.coverage;
    var head = hero('Shift coverage', 'The weekly schedule crossed with the on-premise snapshot.') + covSources();
    if (!c.schedule || !c.presence) {
      var need = !c.schedule && !c.presence ? 'both reports'
        : !c.schedule ? 'the weekly schedule export' : 'the on-premise export';
      return head + '<section class="suite-panel"><div class="workflow-empty">' +
        'Load ' + esc(need) + ' above to see who is scheduled right now and who is actually on premise.' +
        '</div></section>';
    }
    var res = buildCoverageResult();
    var rows = covFilter(res.rows);
    return head + covControls(res) + covMetrics(res.summary) + covWarnings(res) +
      '<section class="suite-panel">' + covFilters(res) +
      (rows.length ? covTable(rows, res.rows.length)
        : empty('Nothing matches those filters', 'Widen the status or location filter to see more.')) +
      '</section>';
  }

  function readCoverageFile(file, kind) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(e.target.result, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        // raw:false keeps the day header as "8/25/2026" text, which is what maps a
        // merged column to its date; cellDates would turn it into a Date and lose
        // the alignment the parser depends on.
        var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
        if (kind === 'schedule') {
          var parsed = ScheduleCore.parseSchedule(aoa);
          if (!parsed.people.length) throw new Error('No employee rows were found. Is this the "Employee Schedule - Weekly" export?');
          state.coverage.schedule = parsed;
          state.coverage.scheduleFile = file.name;
          cacheSchedule(parsed, file.name);
        } else {
          var pres = ScheduleCore.parseOnPremise(aoa);
          if (!pres.people.length) {
            throw new Error(pres.warnings[0] || 'No employee rows were found. Is this the "On Premise - Simple" export?');
          }
          state.coverage.presence = pres;
          state.coverage.presenceFile = file.name;
          // Each upload re-dates the check from the export time in the file name.
          state.coverage.asOf = ScheduleCore.asOfFromFileName(file.name) || new Date();
        }
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
      if (state.market !== 'all' && (!p || p.market !== state.market)) return false;
      if (!q) return true;
      return ((p ? p.name : '') + ' ' + a.badge + ' ' + a.type + ' ' + a.date).toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
    var rows = all.slice(0, MAX_ROWS);
    var orphans = SuiteData.unmatched(state.profiles, state.stores.attendance);

    return hero('Attendance', 'Occurrences and points, joined to the assignment roster by badge.', 'attendance', 'Log occurrence') +
      (orphans.length ? '<div class="warn-banner"><b>' + orphans.length + '</b> attendance record' +
        (orphans.length === 1 ? '' : 's') + ' could not be matched to a badge on the roster and are not counted in any profile.</div>' : '') +
      '<section class="suite-panel">' +
      '<div class="filter-row"><input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="Search by name, badge, type, or date…"></div>' +
      (rows.length ? '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
        '<th>Date</th><th>Associate</th><th>Type</th><th>Minutes</th><th>Points</th><th>Running pts</th><th>Notes</th><th></th></tr></thead><tbody>' +
        rows.map(function (a) {
          var p = profile(a.badge);
          return '<tr><td>' + esc(a.date) + '</td>' +
            '<td>' + (p ? '<div class="name link" data-profile="' + esc(p.badge) + '">' + esc(p.name) + '</div><div class="sub">' + esc(p.badge) + '</div>'
              : '<div class="name">Badge ' + esc(a.badge) + '</div><div class="sub warn-text">Not on roster</div>') + '</td>' +
            '<td>' + esc(a.type) + '</td><td>' + esc(a.minutes || 0) + '</td><td>' + esc(a.points || 0) + '</td>' +
            '<td>' + (p ? p.points : '—') + '</td><td>' + esc(a.notes || '') + '</td>' +
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
      if (state.market !== 'all' && (!p || p.market !== state.market)) return false;
      if (!q) return true;
      return ((p ? p.name : '') + ' ' + t.badge + ' ' + t.type + ' ' + t.status).toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return String(b.start || '').localeCompare(String(a.start || '')); });
    var rows = all.slice(0, MAX_ROWS);

    return hero('PTO / VTO tracking', 'Approved time off is excused and carries no attendance points.', 'timeoff', 'New request') +
      '<section class="suite-panel">' +
      '<div class="filter-row"><input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="Search by name, badge, type, or status…"></div>' +
      (rows.length ? '<div class="suite-table-wrap"><table class="suite-table"><thead><tr>' +
        '<th>Associate</th><th>Type</th><th>Dates</th><th>Hours</th><th>Status</th><th>Attendance tie-in</th><th></th></tr></thead><tbody>' +
        rows.map(function (t) {
          var p = profile(t.badge);
          return '<tr><td>' + (p ? '<div class="name link" data-profile="' + esc(p.badge) + '">' + esc(p.name) + '</div><div class="sub">' + esc(p.badge) + '</div>'
            : '<div class="name">Badge ' + esc(t.badge) + '</div><div class="sub warn-text">Not on roster</div>') + '</td>' +
            '<td><span class="row-type ' + (t.type === 'VTO' ? 'vto' : t.type === 'Sick' ? 'sick' : '') + '">' + esc(t.type) + '</span></td>' +
            '<td>' + esc(t.start) + (t.end && t.end !== t.start ? ' → ' + esc(t.end) : '') + '</td>' +
            '<td>' + esc(t.hours || 0) + '</td>' +
            '<td><span class="status ' + (t.status === 'Pending' ? 'pending' : t.status === 'Denied' ? 'closed' : '') + '">' + esc(t.status) + '</span></td>' +
            '<td>' + (t.status === 'Approved' ? 'Excused · 0 points' : t.status === 'Denied' ? 'Points still apply' : 'Not posted') + '</td>' +
            '<td><button class="suite-btn" data-toggle="' + esc(t.id) + '">' + (t.status === 'Pending' ? 'Approve' : 'Set pending') + '</button> ' +
            '<button class="suite-btn danger" data-del="timeoff|' + esc(t.id) + '">Remove</button></td></tr>';
        }).join('') + '</tbody></table></div>' + rowCap(rows.length, all.length)
        : empty('No time-off requests')) + '</section>';
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
    var rows = state.stores.requisitions.filter(function (r) {
      if (state.market !== 'all' && r.market && r.market !== state.market) return false;
      if (!q) return true;
      return (r.id + ' ' + r.title + ' ' + r.department + ' ' + r.shift + ' ' + r.priority + ' ' + r.status).toLowerCase().indexOf(q) !== -1;
    });
    return hero('Requisition tracking', 'Hiring demand from opening through fulfillment.', 'requisition', 'New requisition') +
      '<section class="suite-panel">' +
      '<div class="filter-row"><input class="suite-input" id="suite-search" value="' + esc(state.query) +
      '" placeholder="Search requisitions…"></div>' +
      (rows.length ? reqTable(rows, false) : empty('No requisitions yet')) + '</section>';
  }

  /* ---------- reconciliation ----------
     The existing tool is not reimplemented here. Its DOM (#recon-main, with all
     of its listeners) is MOVED into the suite content area, and moved back out
     before any re-render wipes the shell. */
  function reconciliation() { return '<div id="recon-mount"></div>'; }
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
    requisitions: requisitions, reconciliation: reconciliation
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
    } else if (type === 'badge') {
      input = '<input name="' + name + '" list="roster-list" value="' + esc(value) +
        '" required placeholder="Badge number">' + rosterDatalist();
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
        field('Status', 'status', 'select', 'Pending', ['Pending', 'Approved', 'Denied']) +
        field('Notes', 'notes', 'text', '');
    } else {
      title = 'New requisition';
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
    return SuiteData.saveRecord(name, record).then(function () {
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
  var LOCAL_KEY = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions' };

  /* ---------- events ---------- */
  root.addEventListener('click', function (e) {
    var nav = e.target.closest('[data-nav]');
    if (nav) { go(nav.dataset.nav); return; }

    var prof = e.target.closest('[data-profile]');
    if (prof) { go('profile', prof.dataset.profile); return; }

    var add = e.target.closest('[data-add]');
    if (add) { modal(add.dataset.add, add.dataset.badge || ''); return; }

    var del = e.target.closest('[data-del]');
    if (del) {
      var parts = del.dataset.del.split('|'), name = parts[0], id = parts.slice(1).join('|');
      if (confirm('Remove this record for everyone?')) remove(name, LOCAL_KEY[name], id);
      return;
    }
    var tog = e.target.closest('[data-toggle]');
    if (tog) {
      var t = state.stores.timeOff.find(function (x) { return x.id === tog.dataset.toggle; });
      if (t) persist('timeoff', { id: t.id, badge: t.badge, status: t.status === 'Pending' ? 'Approved' : 'Pending' }, 'timeOff');
      return;
    }
    if (e.target.closest('[data-cov-now]')) { state.coverage.asOf = new Date(); render(); return; }
    if (e.target.closest('[data-cov-clear]')) {
      if (!confirm('Clear the loaded schedule and on-premise files?')) return;
      state.coverage.schedule = state.coverage.presence = null;
      state.coverage.scheduleFile = state.coverage.presenceFile = '';
      state.coverage.asOf = null;
      try { sessionStorage.removeItem(SCHED_CACHE); } catch (err) { /* nothing cached */ }
      render();
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

  root.addEventListener('input', function (e) {
    if (e.target.id !== 'suite-search') return;
    state.query = e.target.value;
    render();
    var i = document.getElementById('suite-search');
    if (i) { i.focus(); i.setSelectionRange(state.query.length, state.query.length); }
  });
  root.addEventListener('change', function (e) {
    if (e.target.id === 'market-picker') { state.market = e.target.value; render(); }
    if (e.target.id === 'status-filter') { state.statusFilter = e.target.value; render(); }

    var cov = e.target.closest('[data-cov]');
    if (cov && cov.files && cov.files[0]) { readCoverageFile(cov.files[0], cov.dataset.cov); return; }
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

  document.addEventListener('click', function (e) {
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

  restoreSchedule();

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
