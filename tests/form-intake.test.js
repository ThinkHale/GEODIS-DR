/* PTO requests from the two Microsoft Forms: reading free-text dates, resolving
   a name to a badge, and the intake endpoint that files them. */
const fs = require('fs');
const path = require('path');
const FI = require('../form-intake.js');
const SC = require('../schedule-core.js');

let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };
const NOW = new Date(2026, 7, 25);            // Tue 25 Aug 2026
const dates = s => FI.parseDates(s, NOW).dates;

console.log('— the date question is free text —');
t('MM/DD/YY as asked', dates('08/25/26')[0] === '2026-08-25');
t('single digits', dates('8/5/26')[0] === '2026-08-05');
t('four-digit year', dates('08/25/2026')[0] === '2026-08-25');
t('comma separated', dates('8/25/26, 8/26/26').length === 2);
t('newline separated', dates('8/25/26\n8/26/26').length === 2);
t('semicolons', dates('8/25/26; 8/26/26').length === 2);
t('"and"', dates('8/25/26 and 8/29/26').length === 2);
t('Spanish "y"', dates('9/1/26 y 9/2/26').length === 2);
t('a range expands', dates('8/25/26 - 8/27/26').length === 3);
t('a tight range with no spaces', dates('8/25/26-8/27/26').length === 3);
t('"to"', dates('8/25/26 to 8/27/26').length === 3);
t('Spanish "al"', dates('8/25/26 al 8/27/26').length === 3);
t('a range across new year', dates('12/30/26 - 1/2/27').length === 4);
t('dashes as separators inside one date', dates('8-25-26')[0] === '2026-08-25');
t('duplicates collapse', dates('8/25/26, 8/25/26').length === 1);
t('output is sorted', JSON.stringify(dates('8/29/26, 8/25/26')) === '["2026-08-25","2026-08-29"]');

console.log('— a bare date has to guess a year —');
t('later this year stays this year', dates('9/1')[0] === '2026-09-01');
t('long past rolls forward', dates('1/2')[0] === '2027-01-02');
t('recent past stays put', dates('8/1')[0] === '2026-08-01');

console.log('— bad input is reported, never silently dropped —');
let p = FI.parseDates('next week sometime', NOW);
t('unreadable text produces no date', p.dates.length === 0);
t('but is kept', p.unparsed[0] === 'next week sometime');
t('and warned about', p.warnings[0].indexOf('Could not read') === 0);
p = FI.parseDates('8/25/26, blah', NOW);
t('a good date survives alongside a bad one', p.dates.length === 1);
t('and the bad one is still reported', p.unparsed.length === 1);
t('impossible dates rejected', dates('2/30/26').length === 0);
t('month 13 rejected', dates('13/1/26').length === 0);
t('backwards range refused', FI.parseDates('8/27/26 - 8/25/26', NOW).warnings.some(w => w.indexOf('ends before it starts') !== -1));
t('absurd range refused', FI.parseDates('1/1/26 - 12/31/26', NOW).warnings.some(w => w.indexOf('looks like a typo') !== -1));
t('and produces nothing rather than 365 records', FI.parseDates('1/1/26 - 12/31/26', NOW).dates.length === 0);

console.log('— consecutive days become one request —');
t('three in a row is one range',
  JSON.stringify(FI.groupRanges(['2026-08-25', '2026-08-26', '2026-08-27'])) ===
  '[{"start":"2026-08-25","end":"2026-08-27","days":3}]');
t('a gap splits them', FI.groupRanges(['2026-08-25', '2026-08-29']).length === 2);
t('across a month boundary still joins', FI.groupRanges(['2026-08-31', '2026-09-01'])[0].days === 2);

console.log('— full vs partial, both languages —');
t('English full', FI.durationOf('A full day') === 'full');
t('English partial', FI.durationOf('A partial day') === 'partial');
t('Spanish full', FI.durationOf('Un día completo') === 'full');
t('Spanish partial', FI.durationOf('Un día parcial') === 'partial');
t('accent-free Spanish still works', FI.durationOf('Un dia parcial') === 'partial');
t('blank is unknown, not assumed', FI.durationOf('') === '');

console.log('— a submission becomes time-off records —');
const profiles = [
  { badge: '215001', name: 'Luz Grachen', market: 'Chicago' },
  { badge: '215002', name: 'Abel Munoz', market: 'Chicago' },
  { badge: '215003', name: 'Twin Person', market: 'Chicago' },
  { badge: '215004', name: 'Twin Person', market: 'Chicago' }
];
const byName = FI.buildNameIndex(profiles, SC.rosterKey);
const sub = {
  name: 'Luz Grachen', shift: '1st', location: 'lego',
  dates: '08/25/26, 08/26/26', duration: 'A full day',
  language: 'en', responseId: '42'
};
let out = FI.toRequests(sub, { byName, rosterKey: SC.rosterKey, now: NOW });
t('one record for the consecutive pair', out.records.length === 1);
const rec = out.records[0];
t('resolved to a badge', rec.badge === '215001');
t('reported as matched', out.matched === true);
t('typed as PTO', rec.type === 'PTO');
t('lands at the start of the pipeline', rec.status === 'Received');
t('start and end set', rec.start === '2026-08-25' && rec.end === '2026-08-26');
t('8 hours per full day', rec.hours === 16);
t('the name is kept for review', rec.name === 'Luz Grachen');
t('shift and location kept', rec.shift === '1st' && rec.location === 'lego');
t('source records which form', rec.source === 'Form (English)');
t('the raw answer is on the record', rec.notes.indexOf('08/25/26, 08/26/26') !== -1);
t('no warnings on a clean submission', out.warnings.length === 0);

console.log('— the roster bridge —');
// The roster says "Luz Grachen"; someone may type "Grachen, Luz".
out = FI.toRequests(Object.assign({}, sub, { name: 'Grachen, Luz' }), { byName, rosterKey: SC.rosterKey, now: NOW });
t('reversed name order still resolves', out.records[0].badge === '215001');
out = FI.toRequests(Object.assign({}, sub, { name: 'luz  grachen' }), { byName, rosterKey: SC.rosterKey, now: NOW });
t('casing and spacing do not matter', out.records[0].badge === '215001');
out = FI.toRequests(Object.assign({}, sub, { name: 'Nobody Here' }), { byName, rosterKey: SC.rosterKey, now: NOW });
t('an unknown name still produces the request', out.records.length === 1);
t('with no badge', out.records[0].badge === '');
t('the name is still on it', out.records[0].name === 'Nobody Here');
t('and it is reported', out.warnings.some(w => w.indexOf('not on the current assignment roster') !== -1));
out = FI.toRequests(Object.assign({}, sub, { name: 'Twin Person' }), { byName, rosterKey: SC.rosterKey, now: NOW });
t('a duplicated name is not guessed at', out.records[0].badge === '');
t('and says so', out.ambiguous === true && out.warnings.some(w => w.indexOf('More than one associate') !== -1));

console.log('— partial days —');
out = FI.toRequests(Object.assign({}, sub, { dates: '8/25/26', duration: 'A partial day' }), { byName, rosterKey: SC.rosterKey, now: NOW });
t('defaults to 4 hours', out.records[0].hours === 4);
t('and asks for confirmation', out.warnings.some(w => w.indexOf('no hours were given') !== -1));
t('flagged in the notes', out.records[0].notes.indexOf('Partial day') === 0);
out = FI.toRequests(Object.assign({}, sub, { dates: '8/25/26', duration: 'A partial day', hours: 6 }), { byName, rosterKey: SC.rosterKey, now: NOW });
t('stated hours are used', out.records[0].hours === 6);
t('and no warning then', !out.warnings.some(w => w.indexOf('no hours') !== -1));
out = FI.toRequests(Object.assign({}, sub, { duration: '' }), { byName, rosterKey: SC.rosterKey, now: NOW });
t('a blank duration is treated as full and reported', out.records[0].hours === 16 &&
  out.warnings.some(w => w.indexOf('blank or unrecognised') !== -1));

console.log('— Spanish form —');
out = FI.toRequests({ name: 'Abel Munoz', dates: '9/1/26', duration: 'Un día completo', language: 'es', responseId: '7' },
  { byName, rosterKey: SC.rosterKey, now: NOW });
t('resolves the same way', out.records[0].badge === '215002');
t('full day recognised', out.records[0].hours === 8);
t('source records the Spanish form', out.records[0].source === 'Form (Spanish)');

console.log('— re-running the flow must not duplicate —');
const a = FI.toRequests(sub, { byName, rosterKey: SC.rosterKey, now: NOW });
const b = FI.toRequests(sub, { byName, rosterKey: SC.rosterKey, now: NOW });
t('the same response id gives the same request id', a.records[0].id === b.records[0].id);
t('id is derived from the response id', a.records[0].id === 'FORM-42-0');
const noId = Object.assign({}, sub); delete noId.responseId;
const c1 = FI.toRequests(noId, { byName, rosterKey: SC.rosterKey, now: NOW });
const c2 = FI.toRequests(noId, { byName, rosterKey: SC.rosterKey, now: NOW });
t('without a response id it is still stable', c1.records[0].id === c2.records[0].id);
const other = FI.toRequests(Object.assign({}, noId, { dates: '9/9/26' }), { byName, rosterKey: SC.rosterKey, now: NOW });
t('but a different submission differs', other.records[0].id !== c1.records[0].id);
const split = FI.toRequests(Object.assign({}, sub, { dates: '8/25/26, 8/29/26' }), { byName, rosterKey: SC.rosterKey, now: NOW });
t('two ranges get two distinct ids', split.records.length === 2 && split.records[0].id !== split.records[1].id);

console.log('— the raw Forms body plus a field map —');
/* Splicing free text into a JSON template breaks on a newline or a quote, and
   "Which date(s)" is a multi-line box. Sending the whole response object plus a
   map of question ids keeps every value in the flow's own JSON static. */
const FIELDS = {
  name: 'rc6fca2485d3244b480f0bd64957e6d8c',
  shift: 'rb862870f041743bbb5a27c895810b36b',
  location: 'rdc2ac75aba6f4c5f965a2b69df0e5479',
  dates: 'r0ca2a28b610e4e649900652fbe5f8b5e',
  duration: 'rb2b6e9b563dd4cf0a958c465d05f197c'
};
const rawBody = {
  language: 'en', responseId: '99', fields: FIELDS,
  response: {
    responseId: '99', submitDate: '2026-08-25T09:00:00Z',
    'rc6fca2485d3244b480f0bd64957e6d8c': 'Luz Grachen',
    'rb862870f041743bbb5a27c895810b36b': '1st',
    'rdc2ac75aba6f4c5f965a2b69df0e5479': 'lego',
    // Exactly what breaks a string template: newlines and a quote.
    'r0ca2a28b610e4e649900652fbe5f8b5e': '08/25/26\n08/26/26\n"maybe 8/29/26"',
    'rb2b6e9b563dd4cf0a958c465d05f197c': 'A full day'
  }
};
let flat = FI.normalizeSubmission(rawBody);
t('name picked out by question id', flat.name === 'Luz Grachen');
t('shift picked out', flat.shift === '1st');
t('location picked out', flat.location === 'lego');
t('duration picked out', flat.duration === 'A full day');
t('language carried through', flat.language === 'en');
t('responseId carried through', flat.responseId === '99');
t('a newline in the answer is just text now', flat.dates.indexOf('\n') !== -1);

out = FI.toRequests(rawBody, { byName, rosterKey: SC.rosterKey, now: NOW });
t('newline-separated dates parse', out.dates.length >= 2);
t('the quoted junk is reported, not fatal', out.unparsed.length === 1);
t('still resolves to a badge', out.records[0].badge === '215001');
t('id still comes from the response id', out.records[0].id.indexOf('FORM-99-') === 0);
t('a quote in the answer cannot break anything', out.records.length >= 1);

t('responseId falls back to the response body',
  FI.normalizeSubmission({ fields: FIELDS, response: rawBody.response }).responseId === '99');
t('submitDate falls back too',
  FI.normalizeSubmission({ fields: FIELDS, response: rawBody.response }).submittedAt === '2026-08-25T09:00:00Z');
t('a "body/" prefixed key is accepted',
  FI.normalizeSubmission({ fields: { name: 'abc' }, response: { 'body/abc': 'Someone' } }).name === 'Someone');
t('an explicit top-level value wins over the map',
  FI.normalizeSubmission(Object.assign({ name: 'Override Me' }, rawBody)).name === 'Override Me');
t('a missing question id is simply absent',
  FI.normalizeSubmission({ fields: { name: 'nope' }, response: {} }).name === undefined);

console.log('— the flat shape still works —');
t('no response object means pass-through',
  FI.normalizeSubmission({ name: 'Luz Grachen', dates: '8/25/26' }).name === 'Luz Grachen');
t('and still produces records',
  FI.toRequests({ name: 'Luz Grachen', dates: '8/25/26', duration: 'A full day', responseId: '1' },
    { byName, rosterKey: SC.rosterKey, now: NOW }).records.length === 1);

console.log('— shared modules stay in sync between root and functions —');
['reconcile-core.js', 'schedule-core.js', 'form-intake.js'].forEach(f => {
  const rootFile = path.join(__dirname, '..', f);
  const fnFile = path.join(__dirname, '..', 'functions', f);
  t(f + ' copied into functions/', fs.existsSync(fnFile));
  if (fs.existsSync(fnFile)) {
    t(f + ' is byte-identical', fs.readFileSync(rootFile, 'utf8') === fs.readFileSync(fnFile, 'utf8'));
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
