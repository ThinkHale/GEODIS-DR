'use strict';

const ELIGIBLE = ['Approved', 'Submitted to Payroll', 'Completed'];
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function eligible(rec) {
  return !!rec && rec.type === 'PTO' && rec.legacyBalanceApplied !== 'true' && ELIGIBLE.indexOf(rec.status) !== -1;
}
function profile(rows, badge) {
  const b = String(badge || '').trim();
  return (rows || []).find(r => r && String(r.badge || '').trim() === b && (r.transitionAssociate === true || r.transitionAssociate === 'true'));
}
function apply(previous, rec, rows, now) {
  const p = profile(rows, rec.badge);
  const oldHours = previous && Number(previous.transitionHours) > 0 ? Number(previous.transitionHours) : 0;
  const requested = eligible(rec) ? Math.max(0, Number(rec.hours || 0)) : 0;
  if (!p) { rec.transitionHours = 0; rec.accrualHours = round2(requested); rec.transitionAppliedAt = ''; return rec; }
  const available = Math.max(0, Number(p.transitionPtoBalance || 0) + oldHours);
  const used = Math.min(requested, available);
  rec.transitionHours = round2(used);
  rec.accrualHours = round2(requested - used);
  rec.transitionAppliedAt = requested ? now : '';
  p.transitionPtoBalance = round2(available - used);
  p.updatedAt = now;
  return rec;
}
function release(rec, rows, now) {
  const p = profile(rows, rec && rec.badge), used = rec && Number(rec.transitionHours) > 0 ? Number(rec.transitionHours) : 0;
  if (p && used) { p.transitionPtoBalance = round2(Number(p.transitionPtoBalance || 0) + used); p.updatedAt = now; }
  return p;
}
module.exports = { eligible, apply, release };
