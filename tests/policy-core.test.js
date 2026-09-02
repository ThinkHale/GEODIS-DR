/* Verified, scoped attendance + performance policy. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const P = require('../policy-core.js');
let pass = 0, fail = 0;
const t = (name, condition) => {
  if (condition) pass++;
  else { fail++; console.log('  FAIL: ' + name); }
};
const clone = value => JSON.parse(JSON.stringify(value));
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function policy(overrides) {
  const base = {
    id: 'chi-attendance-2026',
    name: 'Chicago Attendance and Performance',
    version: '2026.1',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    markets: ['Chicago'],
    sites: ['100', '200'],
    verifiedAt: '2025-12-15T15:00:00Z',
    verifiedBy: 'Policy Owner',
    pointValues: {
      Present: 0,
      Late: 0.5,
      'Early Out': 0.5,
      Absent: 1,
      'No Call / No Show': 2,
      Excused: 0
    },
    bands: [
      { max: 3, standing: 'Good standing', cls: 'ok' },
      { max: 5, standing: 'Verbal warning', cls: 'warn' },
      { max: 7, standing: 'Written warning', cls: 'warn' },
      { max: 9, standing: 'Final warning', cls: 'bad' },
      { max: null, standing: 'Termination review', cls: 'bad' }
    ],
    performanceWeights: { quality: 50, productivity: 30, safety: 20 },
    performanceMissing: 'require-all',
    performancePrecision: 1
  };
  return Object.assign(base, overrides || {});
}
const context = { market: 'Chicago', site: '100', at: '2026-09-01T12:00:00-05:00' };

console.log('— complete metadata is necessary but verification is separate —');
let checked = P.validatePolicy(policy());
t('a complete policy is structurally valid', checked.valid === true);
t('verification actor and time make it verified', checked.verified === true);
t('normalization keeps an open-ended final band', checked.policy.bands[4].max === Infinity);
let meta = P.policyMetadata(policy());
t('metadata exposes id, name, and version',
  meta.id === 'chi-attendance-2026' && meta.name === 'Chicago Attendance and Performance' && meta.version === '2026.1');
t('metadata exposes the effective window',
  meta.effectiveFrom === '2026-01-01' && meta.effectiveTo === '2026-12-31');
t('metadata exposes market and site scope',
  meta.markets[0] === 'Chicago' && meta.sites.join(',') === '100,200' && /Sites 100, 200/.test(meta.scopeLabel));
t('metadata exposes who verified it and when',
  meta.verified && meta.verifiedBy === 'Policy Owner' && meta.verifiedAt === '2025-12-15T15:00:00Z');

let draft = policy({ verifiedAt: '', verifiedBy: '' });
checked = P.validatePolicy(draft);
t('a complete draft can be structurally valid', checked.valid === true);
t('a draft is not verified', checked.verified === false && checked.verificationErrors.length === 2);
t('metadata never promotes that draft', P.policyMetadata(draft).verified === false);

console.log('— market, site, and effective-date scope —');
t('the exact market/site/date applies', P.policyApplies(policy(), context));
t('scope matching is case-insensitive',
  P.scopeMatches(policy(), { market: 'chicago', site: '100' }));
t('another market is outside scope',
  !P.policyApplies(policy(), { market: 'St. Louis', site: '100', at: '2026-09-01' }));
t('another site is outside scope',
  !P.policyApplies(policy(), { market: 'Chicago', site: '300', at: '2026-09-01' }));
t('missing scoped context fails closed',
  !P.policyApplies(policy(), { market: 'Chicago', at: '2026-09-01' }));
t('the day before effective date is excluded',
  !P.policyApplies(policy(), { market: 'Chicago', site: '100', at: '2025-12-31' }));
t('the final effective day is included',
  P.policyApplies(policy(), { market: 'Chicago', site: '100', at: '2026-12-31' }));
t('the day after expiration is excluded',
  !P.policyApplies(policy(), { market: 'Chicago', site: '100', at: '2027-01-01' }));
const globalPolicy = policy({ id: 'global', markets: [], sites: [], effectiveTo: '' });
t('an explicitly global policy covers any market/site',
  P.policyApplies(globalPolicy, { market: 'St. Louis', site: '999', at: '2026-09-01' }));

console.log('— resolving the one authoritative policy —');
const marketPolicy = policy({ id: 'market', sites: [] });
const sitePolicy = policy({ id: 'site' });
let resolution = P.resolvePolicy([globalPolicy, marketPolicy, sitePolicy], context);
t('the most specific applicable policy wins',
  resolution.authoritative && resolution.policy.id === 'site');
t('resolution carries verified metadata',
  resolution.metadata.verified && resolution.metadata.version === '2026.1');

const early = policy({ id: 'early', sites: [], effectiveFrom: '2026-01-01' });
const later = policy({ id: 'later', sites: [], effectiveFrom: '2026-06-01' });
resolution = P.resolvePolicy([early, later], context);
t('the latest effective version wins at equal specificity', resolution.policy.id === 'later');

const collision = policy({ id: 'collision', sites: [], effectiveFrom: '2026-06-01' });
resolution = P.resolvePolicy([later, collision], context);
t('equally specific policies with the same start fail closed',
  !resolution.authoritative && resolution.code === 'ambiguous-policy');
t('no configuration is explicitly missing',
  P.resolvePolicy([], context).code === 'missing-policy');
t('an in-scope draft is explicitly unverified',
  P.resolvePolicy([draft], context).code === 'unverified-policy');
t('a verified policy for another market is out of scope',
  P.resolvePolicy([policy()], { market: 'St. Louis', site: '100', at: '2026-09-01' }).code === 'out-of-scope');
t('a verified policy outside its dates is not effective',
  P.resolvePolicy([policy()], { market: 'Chicago', site: '100', at: '2027-01-01' }).code === 'not-effective');
const incomplete = policy(); delete incomplete.pointValues.Absent;
t('an incomplete calculation policy is invalid, not partly authoritative',
  P.resolvePolicy([incomplete], context).code === 'invalid-policy');

console.log('— attendance facts, values, and standing bands —');
resolution = P.resolvePolicy([policy()], context);
t('the verified absence value is available', P.pointValue('Absent', resolution) === 1);
t('point type lookup tolerates case only', P.pointValue('absent', resolution) === 1);
t('zero remains a real configured value', P.pointValue('Present', resolution) === 0);
t('an unmapped type is not silently zero', P.pointValue('Other', resolution) === null);

const rawOccurrence = { type: 'Absent', points: 7, source: 'Imported workbook' };
let occurrence = P.evaluateAttendance(rawOccurrence, resolution);
t('raw attendance facts remain visible',
  occurrence.raw.points === 7 && occurrence.raw.source === 'Imported workbook' && occurrence.rawPoints === 7);
t('verified policy supplies the authoritative value',
  occurrence.points === 1 && occurrence.authoritative === true && occurrence.policyMetadata.id === 'chi-attendance-2026');
t('evaluation does not mutate the source fact', rawOccurrence.points === 7 && !own(rawOccurrence, 'authoritative'));
occurrence = P.evaluateAttendance({ type: 'Other', points: 4 }, resolution);
t('an unknown type retains raw points but has no authoritative value',
  occurrence.rawPoints === 4 && occurrence.points === null && occurrence.code === 'unmapped-attendance-type');

let band = P.bandFor(3, resolution);
t('a boundary stays in its configured lower band', band.standing === 'Good standing' && band.authoritative);
t('the next fraction crosses the boundary', P.bandFor(3.5, resolution).standing === 'Verbal warning');
band = P.bandFor(12, resolution);
t('the open-ended band is represented safely',
  band.standing === 'Termination review' && band.max === null && band.openEnded === true);

let summary = P.attendanceSummary([
  { type: 'Absent', points: 2 }, { type: 'Late', points: 0.5 }
], resolution);
t('a summary keeps the imported raw total', summary.rawTotal === 2.5);
t('and calculates its policy total and standing separately',
  summary.points === 1.5 && summary.standing === 'Good standing' && summary.authoritative);
summary = P.attendanceSummary([{ type: 'Other', points: 2 }], resolution);
t('one unmapped occurrence prevents an authoritative total and standing',
  summary.points === null && summary.standing === null && !summary.authoritative);

console.log('— safe behavior without verified policy —');
const unverified = P.resolvePolicy([draft], context);
occurrence = P.evaluateAttendance({ type: 'Absent', points: 9, note: 'raw fact' }, unverified);
t('unverified attendance keeps raw facts', occurrence.rawPoints === 9 && occurrence.raw.note === 'raw fact');
t('unverified attendance never emits policy points', occurrence.points === null && !occurrence.authoritative);
band = P.bandFor(9, unverified);
t('unverified points never emit a standing label',
  band.rawPoints === 9 && band.standing === null && !band.authoritative && band.code === 'unverified-policy');
summary = P.attendanceSummary([{ type: 'Absent', points: 9 }], unverified);
t('unverified summaries retain facts without totals or standings',
  summary.rawTotal === 9 && summary.points === null && summary.standing === null && !summary.authoritative);

console.log('— weighted performance formula —');
resolution = P.resolvePolicy([policy()], context);
const weights = P.performanceWeights(resolution);
t('authored weights are normalized for calculation',
  weights.quality === 0.5 && weights.productivity === 0.3 && weights.safety === 0.2);
const metrics = { quality: 90, productivity: 80, safety: 100, units: 412 };
let composite = P.performanceComposite(metrics, resolution);
t('the configured weighted score is calculated', composite.score === 89 && composite.authoritative);
t('calculation details expose each weighted component',
  composite.components.length === 3 && composite.components.some(row => row.key === 'quality' && row.contribution === 45));
t('non-formula raw metrics remain available', composite.raw.units === 412 && composite.metrics.units === 412);
t('the metrics object is not mutated', metrics.quality === 90 && !own(metrics, 'score'));

composite = P.performanceComposite({ quality: 90, productivity: 80 }, resolution);
t('require-all refuses to invent a partial composite',
  composite.score === null && !composite.authoritative && composite.code === 'missing-performance-metric' && composite.missing[0] === 'safety');

const renormalized = policy({ performanceMissing: 'renormalize' });
const renormResolution = P.resolvePolicy([renormalized], context);
composite = P.performanceComposite({ quality: 90, productivity: 80 }, renormResolution);
t('renormalize works only when the verified policy explicitly asks for it',
  composite.score === 86.3 && composite.authoritative);
t('no numeric facts yields no composite',
  P.performanceComposite({ quality: 'not measured' }, resolution).code === 'no-performance-facts');
composite = P.performanceComposite({ quality: 90, note: 'raw only' }, unverified);
t('unverified performance retains raw metrics', composite.raw.quality === 90 && composite.raw.note === 'raw only');
t('unverified performance exposes neither weights nor a composite',
  composite.score === null && composite.weights === null && !composite.authoritative);
t('weights cannot be read authoritatively from an unverified policy',
  P.performanceWeights(unverified) === null);

console.log('— invalid configurations fail closed —');
let bad = policy({ effectiveFrom: '2026-02-30' });
t('an impossible effective date is invalid', !P.validatePolicy(bad).valid);
bad = policy({ bands: [{ max: 3, standing: 'Good' }, { max: 9, standing: 'Final' }] });
t('a finite final band is invalid', !P.validatePolicy(bad).valid);
bad = policy({ performanceWeights: { quality: 1, safety: -1 } });
t('a negative performance weight is invalid', !P.validatePolicy(bad).valid);
bad = policy({ performanceMissing: 'guess' });
t('an unknown missing-data rule is invalid', !P.validatePolicy(bad).valid);

console.log('— browser/server parity —');
const browserPath = path.join(__dirname, '..', 'policy-core.js');
const serverPath = path.join(__dirname, '..', 'functions', 'policy-core.js');
const browserSource = fs.readFileSync(browserPath, 'utf8');
const serverSource = fs.readFileSync(serverPath, 'utf8');
t('browser and Cloud Function policy cores are byte-identical', browserSource === serverSource);
const sandbox = { window: {} };
vm.runInNewContext(browserSource, sandbox);
t('UMD exposes PolicyCore in a browser',
  !!sandbox.window.PolicyCore && typeof sandbox.window.PolicyCore.resolvePolicy === 'function');
t('the server copy exports the same API',
  Object.keys(require('../functions/policy-core.js')).join('|') === Object.keys(P).join('|'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
