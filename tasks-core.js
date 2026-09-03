/* GEODIS Management Suite -- standing tasks.
 *
 * The things that have to be DONE, as opposed to the things that have merely
 * been recorded. A PTO request nobody has actioned, hours that need correcting,
 * an assignment somebody noticed should be ended: each of those is a job that
 * outlives the page it was noticed on, and each stays until a person says it is
 * finished.
 *
 * Two kinds of task live here together:
 *
 *   Standing tasks are records of their own, raised by hand from the + button.
 *   They are the ones with nowhere else to live -- "end this assignment", "add
 *   this person to Beeline".
 *
 *   Derived tasks are not stored at all. A pending PTO request and an open
 *   payroll discrepancy are already records on their own pages; copying them
 *   into a task record would mean two things to keep in step and two places to
 *   mark done. They are projected into the task shape on read instead, so the
 *   queue is complete without anything being duplicated.
 *
 * On urgency: it is COMPUTED from how long a task has sat, never stored. A
 * stored flag would need something to run on a timer to flip it, and would be
 * wrong in between -- a task raised at 4pm would read as calm all night. Age is
 * a function of the clock, so asking the clock is both simpler and always right.
 */
(function (root, Pipeline) {
  'use strict';

  /* ---------- what a task is about ----------
     `panel` is where the work actually gets done, so a derived task can send
     somebody to the page that owns it rather than pretending to be actionable
     here. `hours` is how long it may sit before it is urgent. */
  var KINDS = [
    { key: 'pto',       label: 'PTO request',      panel: 'timeoff',    hours: 48 },
    { key: 'payroll',   label: 'Payroll issue',    panel: 'payroll',    hours: 4 },
    { key: 'terminate', label: 'End assignment',   panel: 'associates', hours: 48 },
    { key: 'system',    label: 'Add to a system',  panel: 'associates', hours: 48 },
    { key: 'attendance',label: 'Attendance note',  panel: 'attendance', hours: 48 },
    /* What the reconciliation says about somebody, raised as a job: chase the
       system that disagrees. It has no panel of its own -- the answer is on the
       associate's record -- so it points there. */
    { key: 'status',    label: 'Status update',    panel: 'associates', hours: 48 },
    { key: 'note',      label: 'Follow up',        panel: 'tasks',      hours: 48 },
    // The escape hatch. Everything the other kinds do not describe.
    { key: 'other',     label: 'Other',            panel: 'tasks',      hours: 48 }
  ];
  var DEFAULT_KIND = 'note';
  var EXCEPTION_TYPES = ['Absent', 'Late', 'Left early'];
  var ISSUE_TYPES = ['Not paid', 'Shorted hours', 'PTO not issued', 'Other'];
  var KIND_BY_KEY = {};
  KINDS.forEach(function (k) { KIND_BY_KEY[k.key] = k; });

  // Anything not in the list is shown as itself and treated as ordinary work,
  // rather than being silently relabelled or given no ageing rule at all.
  function kindMeta(key) {
    var k = String(key == null ? '' : key).trim();
    return KIND_BY_KEY[k] || { key: k || DEFAULT_KIND, label: k || 'Follow up',
      panel: 'tasks', hours: 48, unknown: !!k };
  }

  /* ---------- status ---------- */
  var STATUSES = [
    { key: 'Open',        label: 'Open',        cls: 'pending', resolved: false },
    { key: 'In Progress', label: 'In progress', cls: 'pending', resolved: false },
    { key: 'Blocked',     label: 'Blocked',     cls: 'warn',    resolved: false },
    { key: 'Complete',    label: 'Complete',    cls: '',        resolved: true, terminal: true },
    { key: 'Cancelled',   label: 'Cancelled',   cls: 'closed',  resolved: false, terminal: true }
  ];
  var pipeline = Pipeline.create({
    statuses: STATUSES,
    defaultStatus: 'Open',
    legacy: { 'New': 'Open', 'Pending': 'Open', 'Done': 'Complete', 'Closed': 'Complete' }
  });

  /* ---------- ageing ----------
     The clock starts at the last update, not at creation: touching a task is
     evidence somebody is on it, and should buy the same grace a new one gets. */
  var URGENT = 'urgent', DUE = 'due', OK = 'ok', NONE = 'none';

  function lastTouch(task) {
    return (task && (task.updatedAt || task.statusUpdatedAt || task.createdAt)) || '';
  }
  function hoursSince(iso, now) {
    var t = Date.parse(iso || '');
    if (isNaN(t)) return 0;      // no timestamp is not evidence of age
    var ms = (now ? now.getTime() : Date.now()) - t;
    return ms <= 0 ? 0 : ms / 3600000;
  }
  function limitFor(task) {
    var explicit = Number(task && task.urgentAfterHours);
    if (isFinite(explicit) && explicit > 0) return explicit;
    return kindMeta(task && task.kind).hours;
  }
  /* A finished task never ages. Beyond its limit it is urgent; in the last
     quarter of it, it is "due" -- a warning that costs nothing and gives
     somebody a chance to act before the escalation. */
  function urgencyOf(task, now) {
    if (!task) return NONE;
    if (!pipeline.needsAction(task.status)) return NONE;
    var limit = limitFor(task);
    var age = hoursSince(lastTouch(task), now);
    if (age >= limit) return URGENT;
    if (age >= limit * 0.75) return DUE;
    return OK;
  }
  function isUrgent(task, now) { return urgencyOf(task, now) === URGENT; }
  function isOpen(task) { return !!task && pipeline.needsAction(task.status); }

  // "3h left", "9h over" -- the number somebody needs to triage by.
  function ageLabel(task, now) {
    if (!isOpen(task)) return '';
    var left = limitFor(task) - hoursSince(lastTouch(task), now);
    var abs = Math.abs(left);
    var n = abs >= 48 ? Math.round(abs / 24) + 'd' : Math.max(1, Math.round(abs)) + 'h';
    return left >= 0 ? n + ' left' : n + ' over';
  }

  /* ---------- the stored shape ---------- */
  function normalize(rec) {
    rec = rec || {};
    var kind = kindMeta(rec.kind).key;
    return {
      id: String(rec.id || ''),
      kind: kind,
      title: String(rec.title || '').trim(),
      detail: String(rec.detail || '').trim(),
      badge: String(rec.badge || ''),
      name: String(rec.name || '').trim(),
      market: String(rec.market || ''),
      location: String(rec.location || ''),
      assignee: String(rec.assignee || '').trim(),
      /* The account behind that name. The name alone is what somebody typed,
         and two people called Chris are one person to a string comparison --
         so the join is on the email the account is keyed by, and the name is
         carried alongside only so a row still reads as words. Empty for a task
         assigned before this existed, or to somebody with no account. */
      assigneeEmail: String(rec.assigneeEmail || '').trim().toLowerCase(),
      due: String(rec.due || '').trim(),
      priority: String(rec.priority || 'Normal').trim(),
      status: pipeline.normalizeStatus(rec.status),
      source: String(rec.source || 'Raised by hand'),
      // What this task came from, so a duplicate is not raised for the same
      // thing twice and the row can link back to it.
      sourceKind: String(rec.sourceKind || ''),
      sourceId: String(rec.sourceId || ''),
      /* What the kind-specific forms capture. Kept as fields rather than folded
         into the title, so a payroll issue can be counted by type and an
         attendance note can be matched to the day it is about -- which is what
         lets completeTasksFromSourceEvidence() close it when the workbook
         catches up. A kind that does not use one simply leaves it empty. */
      exceptionType: String(rec.exceptionType || '').trim(),
      exceptionDate: String(rec.exceptionDate || '').trim(),
      weekEnding: String(rec.weekEnding || '').trim(),
      issueType: String(rec.issueType || '').trim(),
      currentStatus: String(rec.currentStatus || '').trim(),
      urgentAfterHours: Number(rec.urgentAfterHours) > 0 ? Number(rec.urgentAfterHours) : 0,
      createdAt: rec.createdAt || '',
      createdBy: rec.createdBy || '',
      updatedAt: rec.updatedAt || rec.createdAt || '',
      statusUpdatedAt: rec.statusUpdatedAt || '',
      statusUpdatedBy: rec.statusUpdatedBy || '',
      statusHistory: Array.isArray(rec.statusHistory) ? rec.statusHistory : []
    };
  }

  /* A new task. `now` is passed in rather than read here so a caller can make
     the whole batch share one timestamp. */
  function create(fields, actor, now) {
    var when = (now && typeof now.toISOString === 'function') ? now : new Date();
    var at = when.toISOString();
    var t = normalize(fields);
    t.id = t.id || 'TK' + when.getTime() + Math.random().toString(36).slice(2, 6);
    t.status = t.status || 'Open';
    t.createdAt = t.createdAt || at;
    t.updatedAt = at;
    t.createdBy = t.createdBy || (actor ? actor.name : '');
    t.statusHistory = t.statusHistory.length ? t.statusHistory
      : [{ status: t.status, at: at, by: actor ? actor.name : 'Unknown',
           byId: actor ? actor.id : '', source: actor ? actor.source : 'local' }];
    return t;
  }

  /* Raising a task for something that already exists elsewhere -- a Terminated
     disposition, say. The id is derived from the source so documenting the same
     thing twice updates one task rather than growing a pile of identical ones. */
  function idFor(sourceKind, sourceId) {
    return 'TK:' + String(sourceKind || 'x') + ':' +
      String(sourceId || '').replace(/[^A-Za-z0-9:_-]/g, '-').slice(0, 80);
  }
  function existing(tasks, sourceKind, sourceId) {
    var id = idFor(sourceKind, sourceId);
    return (tasks || []).filter(function (t) { return t && t.id === id; })[0] || null;
  }

  /* ---------- changing one after it was raised ----------
     Two things about a task turn out to be wrong only once somebody looks at
     the queue. It landed on nobody in particular -- raised by whoever noticed
     it, which is rarely whoever can do it. And its status stopped describing
     reality: the job was finished in Beeline, or handed to another shift, and
     nothing here saw that happen, so it sits Open and escalates forever.

     Both are ONE decision by one person, so they are one patch and one log
     entry. Saving a reassignment whose status change then failed would leave
     the queue telling a new owner they are answerable for a state that never
     happened.

     `null` back means nothing actually moved: opening the dialog, reading it
     and closing it must not put a write and a log line on the record. */
  function applyEdit(task, changes, actor, now) {
    var when = (now && typeof now.toISOString === 'function') ? now : new Date();
    var current = normalize(task);
    changes = changes || {};
    /* Absent and empty mean different things here. Leaving a key out is "do not
       touch this", which is what the dialog sends when it could not offer a
       choice; sending an empty string is "take this off them". */
    var assignee = changes.assignee === undefined ? current.assignee
      : String(changes.assignee || '').trim();
    var email = changes.assigneeEmail === undefined ? current.assigneeEmail
      : String(changes.assigneeEmail || '').trim().toLowerCase();
    var status = changes.status === undefined ? current.status
      : pipeline.normalizeStatus(changes.status);
    var reason = String(changes.note || '').trim();

    var reassigned = assignee !== current.assignee || email !== current.assigneeEmail;
    var moved = status !== current.status;
    if (!reassigned && !moved && !reason) return null;

    /* What the log will say. The status is already a field on the entry, so the
       note carries only what the entry cannot say for itself: who it went to,
       and why somebody overrode it. */
    var said = [];
    if (reassigned) said.push(assignee ? 'Assigned to ' + assignee : 'Left unassigned');
    if (reason) said.push(reason);
    var note = said.join(' — ');

    var patch = moved ? pipeline.applyStatus(current, status, actor, when, note)
      : pipeline.applyNote(current, note, actor, when);
    patch.assignee = assignee;
    patch.assigneeEmail = email;
    /* Ageing runs off updatedAt, so touching a task has to move it: somebody
       just handed one gets the whole window to work it, not whatever was left
       of the last owner's. */
    patch.updatedAt = patch.statusUpdatedAt || when.toISOString();
    return patch;
  }

  /* ---------- derived tasks ----------
     Projections of records that live elsewhere. `derived` marks them as
     read-only here: the status control belongs to the page that owns them. */
  function derive(rec, opts) {
    return {
      id: opts.id,
      kind: opts.kind,
      title: opts.title,
      detail: opts.detail || '',
      badge: rec.badge || '',
      name: rec.name || '',
      market: rec.market || '',
      location: rec.location || '',
      assignee: rec.assignee || '',
      assigneeEmail: rec.assigneeEmail || '',
      due: rec.due || '',
      priority: rec.priority || 'Normal',
      status: rec.status,
      statusLabel: opts.statusLabel || rec.status,
      source: opts.source,
      sourceKind: opts.sourceKind,
      sourceId: rec.id,
      createdAt: rec.submittedAt || rec.createdAt || '',
      updatedAt: rec.statusUpdatedAt || rec.updatedAt || rec.submittedAt || '',
      urgentAfterHours: opts.hours || 0,
      derived: true,
      statusHistory: rec.statusHistory || []
    };
  }

  /* Only what still needs somebody: a request already approved or denied is not
     a task, it is history. `needsAction` comes from that record's OWN pipeline,
     which is why the caller passes it -- time off and payroll disagree about
     which states are finished. */
  function fromRecords(records, spec) {
    return (records || []).filter(function (r) {
      return r && spec.needsAction(r.status);
    }).map(function (r) {
      return derive(r, {
        id: idFor(spec.sourceKind, r.id),
        kind: spec.kind,
        title: spec.titleOf(r),
        detail: spec.detailOf ? spec.detailOf(r) : '',
        statusLabel: spec.statusLabelOf ? spec.statusLabelOf(r) : r.status,
        source: spec.source,
        sourceKind: spec.sourceKind,
        hours: spec.hours || 0
      });
    });
  }

  /* ---------- the queue ----------
     Urgent first, then by how long it has sat. Completed work is not here at
     all unless it is asked for -- the point of the page is what is outstanding. */
  var RANK = {}; RANK[URGENT] = 0; RANK[DUE] = 1; RANK[OK] = 2; RANK[NONE] = 3;

  function sort(tasks, now) {
    return (tasks || []).slice().sort(function (a, b) {
      var d = RANK[urgencyOf(a, now)] - RANK[urgencyOf(b, now)];
      if (d) return d;
      var at = Date.parse(lastTouch(a)) || 0, bt = Date.parse(lastTouch(b)) || 0;
      if (at !== bt) return at - bt;                 // oldest first
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
  }

  function summarize(tasks, now) {
    var out = { total: 0, open: 0, urgent: 0, due: 0, complete: 0, byKind: {} };
    (tasks || []).forEach(function (t) {
      out.total++;
      var k = kindMeta(t.kind).key;
      out.byKind[k] = (out.byKind[k] || 0) + 1;
      if (!isOpen(t)) { out.complete++; return; }
      out.open++;
      var u = urgencyOf(t, now);
      if (u === URGENT) out.urgent++;
      else if (u === DUE) out.due++;
    });
    return out;
  }

  var api = {
    KINDS: KINDS,
    EXCEPTION_TYPES: EXCEPTION_TYPES,
    ISSUE_TYPES: ISSUE_TYPES,
    KIND_KEYS: KINDS.map(function (k) { return k.key; }),
    DEFAULT_KIND: DEFAULT_KIND,
    STATUSES: STATUSES,
    URGENT: URGENT, DUE: DUE, OK: OK, NONE: NONE,
    pipeline: pipeline,
    kindMeta: kindMeta,
    normalize: normalize,
    create: create,
    idFor: idFor,
    existing: existing,
    applyEdit: applyEdit,
    fromRecords: fromRecords,
    lastTouch: lastTouch,
    hoursSince: hoursSince,
    limitFor: limitFor,
    urgencyOf: urgencyOf,
    isUrgent: isUrgent,
    isOpen: isOpen,
    ageLabel: ageLabel,
    sort: sort,
    summarize: summarize
  };
  root.TasksCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this,
   typeof require !== 'undefined' ? require('./pipeline-core.js') : this.PipelineCore);
