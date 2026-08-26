/* GEODIS Management Suite -- the time-off status pipeline.
 *
 * A PTO request moves through a pipeline, not a yes/no. The vocabulary lives
 * here so the browser, the Cloud Function, and the form intake cannot disagree
 * about what a status means -- particularly which ones excuse an absence, since
 * that decides whether attendance points apply.
 *
 * The machinery underneath (normalising, legacy aliases, the change log, the
 * actor) is shared with every other pipeline in the suite -- see pipeline-core.js.
 */
(function (root, Pipeline) {
  'use strict';

  /* The pipeline, in order. `resolved` is the one that carries weight: an excused
     request means the absence is authorised and no attendance points apply.
     Being SENT for approval is not the same as having it, so it is not excused. */
  var STATUSES = [
    { key: 'Received', label: 'Received', cls: 'pending', resolved: false },
    { key: 'Sent for Client Approval', label: 'Sent for client approval', cls: 'pending', resolved: false },
    { key: 'Approved', label: 'Approved', cls: '', resolved: true },
    { key: 'Submitted to Payroll', label: 'Submitted to payroll', cls: '', resolved: true },
    { key: 'Completed', label: 'Completed', cls: '', resolved: true, terminal: true },
    { key: 'Denied', label: 'Denied', cls: 'closed', resolved: false, terminal: true },
    { key: 'Cancelled', label: 'Cancelled', cls: 'closed', resolved: false, terminal: true }
  ];

  var pipeline = Pipeline.create({
    statuses: STATUSES,
    defaultStatus: 'Received',
    // Requests written before the pipeline existed say "Pending". Same thing.
    legacy: { 'Pending': 'Received', 'pending': 'Received', 'New': 'Received' }
  });

  // isExcused is the time-off name for the pipeline's resolved state: the absence
  // is authorised, so no attendance points apply.
  pipeline.isExcused = pipeline.isResolved;

  root.TimeOffCore = pipeline;
  if (typeof module !== 'undefined' && module.exports) module.exports = pipeline;
})(
  typeof window !== 'undefined' ? window : this,
  typeof require !== 'undefined' ? require('./pipeline-core.js')
    : (typeof window !== 'undefined' ? window.PipelineCore : this.PipelineCore)
);
