/* GEODIS Management Suite -- associate spine.
 *
 * Every module in the suite hangs off ONE roster, and that roster is the RC /
 * Beeline assignment snapshot that already lands each morning. There is no
 * second list of people to maintain: a profile exists because an assignment
 * exists, and its status is that assignment's status.
 *
 * Badge is the primary key throughout. It is already the join between Beeline
 * and RC, and it is what the timeclock and attendance reports key on too.
 *
 * Attendance, time off, performance, and requisitions live in shared server
 * collections (see functions/index.js) rather than in localStorage, so every
 * manager sees the same data -- the same way notes and status overrides
 * already work in the reconciliation view.
 */
(function (root) {
  'use strict';

  var API = 'https://syncreport-eusvh7xq5q-uc.a.run.app/';

  // Collection name -> the key the Cloud Function answers with.
  var COLLECTIONS = {
    attendance: 'attendance',
    timeoff: 'timeOff',
    requisitions: 'requisitions',
    reqCandidates: 'reqCandidates',
    performance: 'performance',
    shifts: 'shifts',
    discrepancies: 'discrepancies',
    associatePto: 'associatePto',
    users: 'users',
    locations: 'locations',
    shiftTypes: 'shiftTypes',
    appConfig: 'appConfig',
    timeclockLinks: 'timeclockLinks',
    tasks: 'tasks',
    contacts: 'contacts'
  };

  /* Attendance occurrence thresholds. GEODIS policy varies by site, so these are
     the display bands only -- confirm them against the site's actual attendance
     policy before anyone acts on the "standing" column. */
  var POINT_BANDS = [
    { max: 3, standing: 'Good standing', cls: 'ok' },
    { max: 5, standing: 'Verbal warning', cls: 'warn' },
    { max: 7, standing: 'Written warning', cls: 'warn' },
    { max: 9, standing: 'Final warning', cls: 'bad' },
    { max: Infinity, standing: 'Termination review', cls: 'bad' }
  ];

  /* ---------- helpers ---------- */
  function normBadge(v) {
    if (v == null) return '';
    var s = String(v).trim();
    if (s === '') return '';
    if (/^\d+\.0+$/.test(s)) s = s.split('.')[0];
    return s.replace(/,/g, '').replace(/\s+/g, '');
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function initialsOf(name) {
    return String(name || '?').trim().split(/\s+/).map(function (p) { return p[0]; })
      .filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
  }

  /* ---------- profile status ----------
     Every record in the snapshot is someone with an active assignment in at
     least one system -- indexSide() in reconcile-core.js filters to active rows
     before the two sides are compared. So a profile is Ended only when we have
     positive evidence the assignment stopped:

       - an end date from the RC "Ended Assignments" report, or
       - an action of endCrm  (Beeline shows the assignment non-active), or
       - an action of endBeeline (RC ended them; Beeline is the stale side).

     Everything else is Active. Note this is the assignment's status, not a
     recommendation: endCrm/endBeeline mean the work already ended somewhere and
     one system has not caught up yet. */
  function statusOf(rec) {
    if (rec.endDate) return 'Ended';
    if (rec.action === 'endCrm' || rec.action === 'endBeeline') return 'Ended';
    return 'Active';
  }

  /* ---------- profiles ----------
     records: the snapshot rows already rendered by the reconciliation view,
              with any manual status overrides applied.
     stores:  { attendance: [], timeOff: [], performance: [], notes: {} } */
  /* Every field a profile is expected to have, in one place. Built here rather
     than spelled out twice, because a view reading a field that only one of the
     two paths sets is the kind of bug that shows as a blank cell nobody
     questions. */
  function blankProfile(badge, name) {
    return {
      badge: badge,
      empNumber: '',
      // RC (Salesforce) record ids, for deep links. Empty when RC has no record.
      contactId: '',
      assignmentId: '',
      name: name,
      initials: initialsOf(name),
      altName: '',
      status: 'Active',
      market: 'Other',
      marketVerified: false,
      marketRaw: '',
      // Reconciliation state travels WITH the profile rather than living in a
      // separate tab, so a manager reading a scorecard can see that this
      // person's paperwork is out of sync.
      action: '',
      actionLabel: '',
      actionReason: '',
      overridden: false,
      reconciled: false,
      dup: false,
      newBadge: null,
      crmStart: null,
      beeStart: null,
      endDate: null,
      endReason: '',
      // Joined below.
      attendance: [], points: 0, standing: '', standingCls: '',
      timeOff: [], performance: null, score: null, note: '',
      transitionAssociate: false, transitionPtoInitial: 0, transitionPtoBalance: 0,
      shift: '', shiftBuilding: '', shiftHours: '', shiftSource: '',
      phone: '', phoneSource: '', phoneUpdatedAt: '',
      /* The WFM id, "80-JALCAL5986". Note this is NOT empNumber: the PLX
         workbook heads its column "EID", but that column is the timeclock id,
         while the EID the team searches by is RC's Legacy Contact ID, which
         arrives as empNumber. Two different numbers, one overloaded word. */
      timeclockId: '',
      // Where they work: the GEODIS site number and the client account on it.
      location: '', account: '', locationLabel: ''
      };
  }

  function buildProfiles(records, stores) {
    stores = stores || {};
    var byBadge = new Map();

    (records || []).forEach(function (r) {
      var badge = normBadge(r.badge);
      if (!badge) return;
      var name = r.person || r.crmName || r.beeName || '';
      var p = blankProfile(badge, name);
      p.empNumber = r.empNumber || '';
      // RC (Salesforce) record ids, for deep links. Empty when RC has no record.
      p.contactId = r.contactId || '';
      p.assignmentId = r.assignmentId || '';
      p.altName = r.altName || '';
      p.status = statusOf(r);
      p.market = r.market || 'Other';
      p.marketVerified = !!r.marketVerified;
      p.marketRaw = r.marketRaw || '';
      /* Reconciliation state travels WITH the profile rather than living in a
         separate tab, so a manager reading a scorecard can see that this
         person's paperwork is out of sync. */
      p.action = r.action || '';
      p.actionLabel = r.actionLabel || '';
      p.actionReason = r.reason || '';
      p.overridden = !!r.overridden;
      p.reconciled = r.action === 'matched';
      p.dup = !!r.dup;
      p.newBadge = r.newBadge || null;
      p.crmStart = r.crmStart || null;
      p.beeStart = r.beeStart || null;
      p.endDate = r.endDate || null;
      p.endReason = r.endReason || '';
      byBadge.set(badge, p);
    });

    /* Shift tags come from the PLX workbook and are keyed by WFM EID or name --
       never by badge, because the EID and the RC/Beeline badge are separate
       namespaces with no overlap. The caller supplies the name-key function
       (ScheduleCore.rosterKey) so this file need not know about that module.
       A name carrying two different shifts is poisoned rather than guessed at. */
    var shiftIdx = {};
    if (stores.shifts && stores.shiftKeyOf) {
      stores.shifts.forEach(function (r) {
        if (!r.nameKey) return;
        shiftIdx[r.nameKey] = (shiftIdx[r.nameKey] && shiftIdx[r.nameKey].shift !== r.shift) ? null : r;
      });
    }

    /* ---------- people who have left the roster but not the record ----------
       The snapshot is the CURRENT reconciliation: somebody whose assignment has
       ended in both systems stops appearing in it. Everything already attached
       to them -- a note, a payroll discrepancy, a time-off request, an
       occurrence -- would then point at a profile that no longer exists, and
       become unreachable. Not deleted, just impossible to open.

       That is worse than it sounds. One real example: a note reading "Still
       Active - needs badge updated to 236758 RC" sitting on a badge with no
       profile, which is precisely the note somebody needed to act on.

       So any badge a stored record still refers to keeps a profile, marked as
       former. It carries no assignment detail, because there is none -- what it
       carries is somewhere for the record to live and be added to. */
    var formerName = {};
    [stores.attendance, stores.timeOff, stores.discrepancies, stores.tasks, stores.contacts]
      .forEach(function (rows) {
        (rows || []).forEach(function (r) {
          if (!r || !r.badge || !r.name) return;
          var b = normBadge(r.badge);
          if (!formerName[b]) formerName[b] = r.name;
        });
      });
    var seenBadge = {};
    [stores.attendance, stores.timeOff, stores.discrepancies, stores.tasks, stores.contacts]
      .forEach(function (rows) {
        (rows || []).forEach(function (r) { if (r && r.badge) seenBadge[normBadge(r.badge)] = true; });
      });
    Object.keys(stores.notes || {}).forEach(function (b) { seenBadge[normBadge(b)] = true; });
    Object.keys(seenBadge).forEach(function (badge) {
      if (!badge || byBadge.has(badge)) return;
      var name = formerName[badge] || '';
      var p = blankProfile(badge, name);
      p.status = 'Ended';
      p.former = true;
      p.actionLabel = 'No longer on the roster';
      p.actionReason = 'This badge is not in the current RC / Beeline reconciliation, so their ' +
        'assignment has ended in both systems. The records already against them are kept, and ' +
        'more can still be added.';
      byBadge.set(badge, p);
    });

    attach(byBadge, stores.attendance, 'attendance');
    attach(byBadge, stores.timeOff, 'timeOff');
    (stores.associatePto || []).forEach(function (r) {
      var p = byBadge.get(normBadge(r.badge));
      if (!p) return;
      p.transitionAssociate = r.transitionAssociate === true || r.transitionAssociate === 'true';
      p.transitionPtoInitial = num(r.transitionPtoInitial);
      p.transitionPtoBalance = num(r.transitionPtoBalance);
    });

    // Performance: keep the most recent period per badge.
    (stores.performance || []).forEach(function (m) {
      var p = byBadge.get(normBadge(m.badge));
      if (!p) return;
      if (!p.performance || String(m.period || '') > String(p.performance.period || '')) p.performance = m;
    });

    // Site number -> the client's name, from the admin Locations list.
    var siteName = {};
    (stores.locations || []).forEach(function (l) {
      if (l && l.code && l.name && l.active !== false) siteName[String(l.code).trim()] = l.name;
    });

    /* Timeclock ids connected to a profile by hand, badge -> id. These are the
       decisions somebody made when no rule could join the two namespaces. */
    var linkByBadge = {};
    (stores.timeclockLinks || []).forEach(function (l) {
      if (l && l.badge && l.eid) linkByBadge[normBadge(l.badge)] = l.eid;
    });

    var notes = stores.notes || {};
    byBadge.forEach(function (p) {
      /* Approved time off answers for the day it covers. An occurrence logged
         against a day the person had approved off is left on the ledger -- it
         happened, and deleting it would hide that somebody logged it -- but it
         stops carrying points. What was recorded and what it costs are two
         different questions, and only the second is policy.

         The test is injected (stores.ptoCover) for the same reason shiftKeyOf
         is: this file does not need to know about the time-off pipeline to join
         records by badge. */
      var cover = stores.ptoCover;
      if (cover) {
        /* A COPY is pushed, never the caller's record. attach() shares object
           references with the store, so zeroing in place would edit the stored
           event itself -- the next rebuild would see nothing to excuse, and if
           the request were later denied the original points would be gone. */
        p.attendance = p.attendance.map(function (e) {
          var req = e.date ? cover(p.timeOff, e.date) : null;
          if (!req || !num(e.points)) return e;
          var out = {};
          Object.keys(e).forEach(function (k) { out[k] = e[k]; });
          out.excusedBy = { id: req.id, type: req.type || 'PTO', start: req.start || '', end: req.end || '' };
          out.originalPoints = num(e.points);
          out.points = 0;
          return out;
        });
      }
      p.points = p.attendance.reduce(function (n, e) { return n + num(e.points); }, 0);
      p.excusedByPto = p.attendance.filter(function (e) { return e.excusedBy; }).length;
      var band = bandFor(p.points);
      p.standing = band.standing;
      p.standingCls = band.cls;
      p.score = scoreOf(p);
      p.note = notes[p.badge] ? notes[p.badge].note : '';
      /* The phone number, by whichever key reaches it. Injected like the shift
         lookup so this file need not know how numbers are matched. */
      if (stores.phoneOf) {
        var ph = stores.phoneOf(p);
        if (ph) { p.phone = ph.phone || ''; p.phoneSource = ph.source || ''; p.phoneUpdatedAt = ph.updatedAt || ''; }
      }
      var sr = stores.shiftKeyOf ? shiftIdx[stores.shiftKeyOf(p.name)] : null;
      if (sr && sr.eid) p.timeclockId = sr.eid;
      // A link somebody made by hand beats one inferred from a name.
      if (linkByBadge[p.badge]) p.timeclockId = linkByBadge[p.badge];
      if (sr) {
        p.shift = sr.shift;
        p.shiftBuilding = sr.building || '';
        p.shiftHours = sr.hours || '';
        p.shiftSource = sr.source || '';
        p.location = sr.building || '';
        /* The Key names the account for most rows, but not all -- some buildings
           run a single client the Key never spells out. A site default fills that
           in, and because it is read HERE rather than baked in at import, an
           admin renaming a location in Settings changes every associate at that
           site without a re-import. */
        p.account = sr.account || siteName[String(sr.building || '').trim()] || '';
        // One readable string for tables and sorting. Site first, so sorting by
        // it groups a building together rather than scattering it by client.
        p.locationLabel = [p.location, p.account].filter(Boolean).join(' · ');
      }
      p.attendance.sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
      p.timeOff.sort(function (a, b) { return String(b.start || '').localeCompare(String(a.start || '')); });
    });

    return byBadge;
  }

  // Drop each record onto its badge's profile. Rows whose badge is not on the
  // roster are ignored here and reported separately by unmatched().
  function attach(byBadge, rows, key) {
    (rows || []).forEach(function (row) {
      var p = byBadge.get(normBadge(row.badge));
      if (p) p[key].push(row);
    });
  }

  // Imported rows that did not land on any profile -- a bad badge column, or a
  // person who is not on the current assignment snapshot. Surfaced rather than
  // silently dropped, because a silently dropped attendance point is a
  // disciplinary record that quietly went missing.
  function unmatched(byBadge, rows) {
    return (rows || []).filter(function (row) { return !byBadge.has(normBadge(row.badge)); });
  }

  function bandFor(points) {
    for (var i = 0; i < POINT_BANDS.length; i++) {
      if (points <= POINT_BANDS[i].max) return POINT_BANDS[i];
    }
    return POINT_BANDS[POINT_BANDS.length - 1];
  }

  /* Composite score = the average of whichever performance metrics we actually
     have for this person. It deliberately does NOT fold in attendance points:
     the conversion rate between an occurrence and a score is a policy decision,
     not a math one, so attendance stays its own column with its own standing.
     No performance record means no score -- null renders as "Not scored", never
     as a number nobody measured. */
  function scoreOf(p) {
    var m = p.performance;
    if (!m) return null;
    var parts = ['quality', 'productivity', 'safety'].filter(function (k) {
      return m[k] != null && isFinite(Number(m[k]));
    });
    if (!parts.length) return null;
    var total = parts.reduce(function (n, k) { return n + Number(m[k]); }, 0);
    return Math.round(total / parts.length);
  }

  /* ---------- shared collection I/O ----------
     Every request carries the signed-in account's Firebase ID token. The server
     decides what that account may read and write; nothing here is trusted to
     make that call, and nothing here is reachable without it.

     One request shape, one place the header is attached. A fetch that went
     round this would be an unauthenticated request that silently fails, which
     is the hardest kind of bug to see. */
  function url(name) { return API + '?' + name + '=1'; }

  /* ---------- load state + last-good values ----------
     A failed refresh is not an empty collection. An empty collection is a fact
     returned successfully by the server; a failed refresh means the browser does
     not know what is there now. Keep the last successful value in memory and put
     the failure beside it, so callers can keep rendering trusted data while also
     labelling it stale.

     The cache is deliberately memory-only. These collections contain workforce
     data and must not be copied into localStorage merely to survive a reload. */
  var LOAD_STATE = Object.create(null);
  var LAST_GOOD = Object.create(null);

  function nowIso() { return new Date().toISOString(); }
  function owns(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  function copyData(value) {
    if (value == null || typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
  }
  function publicError(err, at) {
    return {
      name: (err && err.name) || 'Error',
      message: (err && err.message) || 'The source could not be loaded.',
      status: err && (err.status || err.denied) ? Number(err.status || err.denied) : null,
      denied: !!(err && err.denied),
      at: at
    };
  }
  function publicLoadState(source) {
    var s = LOAD_STATE[source];
    if (!s) {
      return { source: source, status: 'idle', hasData: false, attemptedAt: '', loadedAt: '',
        failedAt: '', error: null };
    }
    return {
      source: s.source,
      status: s.status,
      hasData: !!s.hasData,
      attemptedAt: s.attemptedAt || '',
      loadedAt: s.loadedAt || '',
      failedAt: s.failedAt || '',
      error: s.error ? Object.assign({}, s.error) : null
    };
  }
  function getSourceState(source) { return publicLoadState(String(source || '')); }
  function getSourceStates() {
    var out = {};
    Object.keys(LOAD_STATE).forEach(function (source) { out[source] = publicLoadState(source); });
    return out;
  }
  function announceSourceState(source) {
    if (typeof document === 'undefined' || !document.dispatchEvent) return;
    var EventCtor = root.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
    if (!EventCtor) return;
    document.dispatchEvent(new EventCtor('geodis:data-state', {
      detail: publicLoadState(source)
    }));
  }
  function beginLoad(source) {
    var prior = LOAD_STATE[source] || {};
    var attempt = (prior.attempt || 0) + 1;
    var cached = LAST_GOOD[source];
    LOAD_STATE[source] = {
      source: source,
      attempt: attempt,
      status: cached ? 'refreshing' : 'loading',
      hasData: !!cached,
      attemptedAt: nowIso(),
      loadedAt: cached ? cached.loadedAt : '',
      failedAt: '',
      error: null
    };
    announceSourceState(source);
    return attempt;
  }
  function loadSource(source, request) {
    var attempt = beginLoad(source);
    var work;
    try { work = request(); } catch (err) { work = Promise.reject(err); }
    return Promise.resolve(work).then(function (value) {
      /* A slower, older request must not overwrite a newer result. It may still
         answer its own caller, but it no longer owns the shared source state. */
      if (!LOAD_STATE[source] || LOAD_STATE[source].attempt !== attempt) return copyData(value);
      var loadedAt = nowIso();
      LAST_GOOD[source] = { value: copyData(value), loadedAt: loadedAt };
      LOAD_STATE[source] = {
        source: source, attempt: attempt, status: 'ready', hasData: true,
        attemptedAt: LOAD_STATE[source].attemptedAt, loadedAt: loadedAt,
        failedAt: '', error: null
      };
      announceSourceState(source);
      return copyData(value);
    }).catch(function (err) {
      var failedAt = nowIso();
      var cached = LAST_GOOD[source];
      if (LOAD_STATE[source] && LOAD_STATE[source].attempt === attempt) {
        LOAD_STATE[source] = {
          source: source,
          attempt: attempt,
          /* A denied request never serves cached workforce data back into the
             app. The auth gate owns that transition. The cache stays in memory
             only so a successful re-authenticated retry can supersede it. */
          status: err && err.denied ? 'denied' : cached ? 'stale' : 'error',
          hasData: !!cached,
          attemptedAt: LOAD_STATE[source].attemptedAt,
          loadedAt: cached ? cached.loadedAt : '',
          failedAt: failedAt,
          error: publicError(err, failedAt)
        };
        announceSourceState(source);
      }
      if (cached && !(err && err.denied)) return copyData(cached.value);
      err = err || new Error('The source could not be loaded.');
      err.source = source;
      err.sourceState = publicLoadState(source);
      throw err;
    });
  }

  function authHeaders(base) {
    var headers = Object.assign({}, base || {});
    var auth = root.SuiteAuth;
    if (!auth || !auth.idToken) return Promise.resolve(headers);
    return auth.idToken().then(function (token) {
      if (token) headers.Authorization = 'Bearer ' + token;
      return headers;
    }).catch(function () { return headers; });
  }
  function authedFetch(u, opts) {
    opts = opts || {};
    return authHeaders(opts.headers).then(function (headers) {
      return fetch(u, Object.assign({}, opts, { headers: headers }));
    });
  }

  /* A 401 or a 403 is not "the network was flaky". It means this browser is no
     longer allowed to see what it is asking for -- signed out in another tab,
     or a role changed under them. Announced so the shell can put the gate back
     up, rather than left to degrade into a page of empty tables that looks like
     the data was lost. */
  function announceDenied(status) {
    if (typeof document === 'undefined' || !document.dispatchEvent) return;
    document.dispatchEvent(new CustomEvent('geodis:denied', { detail: { status: status } }));
  }
  function checked(res) {
    if (res.status === 401 || res.status === 403) {
      announceDenied(res.status);
      var err = new Error(res.status === 401 ? 'Not signed in.' : 'Not allowed.');
      err.denied = res.status;
      err.status = res.status;
      throw err;
    }
    if (!res.ok) {
      var httpErr = new Error('HTTP ' + res.status);
      httpErr.status = res.status;
      throw httpErr;
    }
    return res.json();
  }

  function loadCollection(name) {
    return loadSource(name, function () {
      if (!COLLECTIONS[name]) throw new Error('Unknown shared collection "' + name + '".');
      return authedFetch(url(name), { cache: 'no-store' })
        .then(checked)
        .then(function (data) {
          var key = COLLECTIONS[name];
          /* Older deployments and several offline fixtures answer `{}` for a
             collection that has never been created. That is still a successful
             server answer, and is the only circumstance in which an absent key
             becomes an empty collection. Network, HTTP, auth and JSON failures
             have already thrown above and can never reach this line. */
          return data && owns(data, key) && Array.isArray(data[key]) ? data[key] : [];
        });
    }).catch(function (err) {
      /* A cache-backed failure has already resolved in loadSource(). Reaching
         this catch means there was no trustworthy value to return. */
      if (!err.denied) console.warn('Could not load the shared "' + name + '" collection.', err);
      throw err;
    });
  }

  // `name` is either a collection name or a ready-made query string.
  function post(name, body) {
    var u = name.indexOf('=') === -1 ? url(name) : API + '?' + name;
    return authedFetch(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        announceDenied(res.status);
        /* The server's own words, not a status code. It knows which role the
           account has and what it was reaching for; "HTTP 403" tells the person
           at the keyboard nothing they can act on. */
        return res.json().catch(function () { return {}; }).then(function (d) {
          var err = new Error(d.error || 'That is not something this account can do.');
          err.denied = res.status;
          throw err;
        });
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function saveRecord(name, record) {
    if (!record.id) record.id = name.slice(0, 2).toUpperCase() + Date.now();
    return post(name, record);
  }
  function deleteRecord(name, id) { return post(name, { id: id, _delete: true }); }
  function replaceCollection(name, records) { return post(name, { records: records }); }

  /* ---------- date-partitioned stores ----------
     The weekly schedule (the plan) and each day's on-premise checks (the
     observations). Both are partitioned by date so one read stays small and a
     re-upload replaces exactly one document. */
  function weekStart(isoDay) {
    // Schedules are stored under the Sunday that starts their week, which is
    // how the WFM export lays them out.
    var d = new Date(isoDay + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    d.setDate(d.getDate() - d.getDay());
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function getJson(u) {
    return authedFetch(u, { cache: 'no-store' }).then(checked);
  }
  function getJsonSource(source, u, select) {
    return loadSource(source, function () {
      return getJson(u).then(select || function (d) { return d; });
    }).catch(function (err) {
      /* loadSource resolves cache-backed failures. Only a source with no trusted
         value (or a denied request) reaches here. Keep the error observable. */
      if (!err.denied) console.warn('Could not load the shared "' + source + '" source.', err);
      throw err;
    });
  }
  /* The reconciliation snapshot -- the roster. Fetched through the function so
     it is behind the same account gate as everything else, rather than straight
     off a public Storage URL that needed no sign-in at all. */
  function loadSnapshot() {
    return getJsonSource('snapshot', API + '?snapshot=1');
  }
  function loadSchedule(period) {
    return getJsonSource('schedule:' + period,
      API + '?schedule=1&period=' + encodeURIComponent(period),
      function (d) { return d.schedule && d.schedule.people ? d.schedule : null; });
  }
  // Which days have stored checks, for the review picker.
  /* Admin collections, loaded only when the Settings page is opened -- most
     visits never need them. */
  function loadAdmin() {
    return Promise.all(['users', 'locations', 'shiftTypes', 'appConfig'].map(loadCollection))
      .then(function (r) { return { users: r[0], locations: r[1], shiftTypes: r[2], appConfig: r[3] }; });
  }

  /* ---------- the PLX workbook ----------
     It lives in another Microsoft tenant, so nothing here can go and fetch it:
     somebody uploads it, and loadPlxSync() reports what that upload produced. */
  function loadPlxSync() {
    return getJsonSource('plxSync', API + '?plx=1', function (d) { return d.sync || {}; });
  }
  /* ---------- the shared IL PTO tracker ----------
     Watched on SharePoint by a flow that fires when the file changes, so unlike
     the PLX workbook nobody has to remember to upload it. This reports what that
     flow last did. */
  function loadIlPtoSync() {
    return getJsonSource('ilPtoSync', API + '?ilPto=1', function (d) { return d.sync || {}; });
  }

  // Uploading the workbook from the browser. Everything it carries -- shift tags,
  // open orders, attendance history and point balances -- refreshes in one pass.
  function uploadPlx(payload) { return post('plxUpload=1', payload); }

  /* ---------- the daily Beeline requisition exports ----------
     Power Automate posts each export here as its email arrives (see SETUP.md).
     The browser only ever READS what those pushes produced; the manual import on
     the Beeline Requests page writes the collections directly, as it always has. */
  function loadReqSync() {
    return getJsonSource('reqSync', API + '?reqSync=1', function (d) { return d.sync || {}; });
  }

  /* ---------- payroll periods ---------- */
  function loadPayrollPeriods() {
    return getJsonSource('payrollPeriods', API + '?payroll=1', function (d) { return d.periods || []; });
  }
  function loadPayrollPeriod(week) {
    return getJsonSource('payrollPeriod:' + week,
      API + '?payroll=1&week=' + encodeURIComponent(week),
      function (d) { return d.period || {}; });
  }
  function savePayrollClose(week, closesAt) {
    return post('payroll=1&week=' + encodeURIComponent(week), { closesAt: closesAt });
  }
  function savePayrollReview(week, review) {
    return post('payroll=1&week=' + encodeURIComponent(week), { review: review });
  }

  function loadCoverageDates() {
    return getJsonSource('coverageDates', API + '?coverage=1', function (d) { return d.dates || []; });
  }
  function loadCoverage(date) {
    return getJsonSource('coverage:' + date,
      API + '?coverage=1&date=' + encodeURIComponent(date),
      function (d) { return d.coverage || {}; });
  }
  function saveCheck(date, check) {
    return post('coverage=1&date=' + encodeURIComponent(date), { check: check });
  }
  function saveDocumentation(date, document) {
    return post('coverage=1&date=' + encodeURIComponent(date), { document: document });
  }

  // Load every shared collection at once. A source with a last-good value returns
  // that value and marks itself stale. A first-load failure rejects the bundle,
  // because manufacturing an empty array would claim the collection was empty.
  function loadAll() {
    return Promise.all(['attendance', 'timeoff', 'requisitions', 'performance', 'shifts',
      'discrepancies', 'associatePto', 'locations', 'appConfig', 'timeclockLinks', 'tasks',
      'contacts', 'reqCandidates']
      .map(function (n) { return loadCollection(n); }))
      .then(function (r) {
        return {
          attendance: r[0], timeOff: r[1], requisitions: r[2],
          performance: r[3], shifts: r[4], discrepancies: r[5], associatePto: r[6],
          // Loaded for everyone, not just admins: it supplies the default account
          // name for sites the Key does not spell out.
          locations: r[7], appConfig: r[8], timeclockLinks: r[9], tasks: r[10], contacts: r[11],
          reqCandidates: r[12]
        };
      });
  }

  root.SuiteData = {
    API: API,
    POINT_BANDS: POINT_BANDS,
    normBadge: normBadge,
    initialsOf: initialsOf,
    statusOf: statusOf,
    buildProfiles: buildProfiles,
    unmatched: unmatched,
    bandFor: bandFor,
    scoreOf: scoreOf,
    loadCollection: loadCollection,
    getSourceState: getSourceState,
    getSourceStates: getSourceStates,
    loadSnapshot: loadSnapshot,
    authedFetch: authedFetch,
    loadAll: loadAll,
    saveRecord: saveRecord,
    deleteRecord: deleteRecord,
    replaceCollection: replaceCollection,
    weekStart: weekStart,
    loadSchedule: loadSchedule,
    loadCoverage: loadCoverage,
    loadCoverageDates: loadCoverageDates,
    loadAdmin: loadAdmin,
    loadPlxSync: loadPlxSync,
    loadReqSync: loadReqSync,
    loadIlPtoSync: loadIlPtoSync,
    uploadPlx: uploadPlx,
    loadPayrollPeriods: loadPayrollPeriods,
    loadPayrollPeriod: loadPayrollPeriod,
    savePayrollClose: savePayrollClose,
    savePayrollReview: savePayrollReview,
    saveCheck: saveCheck,
    saveDocumentation: saveDocumentation
  };
})(typeof window !== 'undefined' ? window : this);
