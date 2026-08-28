/* GEODIS Management Suite -- associate phone numbers.
 *
 * Why this exists: when somebody is not on the floor, the next question is
 * whether they called or texted, and the answer lives in TextUs and Vonage --
 * both of which are searched by phone number. Having the number on the row that
 * says they are missing removes a lookup from every single absence.
 *
 * Numbers are stored as ten digits and nothing else. The sources spell them
 * every possible way -- "(773) 639-5639", "773-639-5639 ", "1 773 639 5639" --
 * and a store that keeps the spelling cannot answer "is this the same number as
 * that one", which is exactly what matching a phone against another system
 * needs. Formatting is a display concern and happens on the way out.
 */
(function (root) {
  'use strict';

  /* ---------- the number itself ---------- */

  /* Ten digits. A leading US country code is dropped; anything else that is not
     ten digits is refused rather than padded or truncated, because a wrong
     number is worse than no number -- it reaches somebody, just not the person
     whose absence is being chased. */
  function normalize(v) {
    var digits = String(v == null ? '' : v).replace(/\D/g, '');
    if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
    if (digits.length !== 10) return '';
    // No US number starts with 0 or 1 in either the area code or the exchange.
    if (/^[01]/.test(digits) || /^[01]/.test(digits.slice(3))) return '';
    return digits;
  }
  function isValid(v) { return !!normalize(v); }
  function format(v) {
    var d = normalize(v);
    if (!d) return '';
    return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  }
  // What a tel: link needs, and what TextUs and Vonage both accept in a search.
  function e164(v) {
    var d = normalize(v);
    return d ? '+1' + d : '';
  }

  /* ---------- reading numbers out of a sheet ----------
     Deliberately not tied to one report. Any sheet with something that looks
     like a name column and something that looks like a phone column will give
     up its numbers, so a tracker somebody already keeps can be used as-is
     rather than being re-keyed. */
  var NAME_COL = /^(employee\s*name|associate|name|full\s*name|employee)$/i;
  var PHONE_COL = /phone|mobile|cell/i;
  var EID_COL = /^(eid|employee\s*id|wfm\s*id)$/i;

  function headerIndex(row, re) {
    for (var i = 0; i < row.length; i++) {
      if (re.test(String(row[i] == null ? '' : row[i]).trim())) return i;
    }
    return -1;
  }

  /* Returns { rows: [{name, nameKey, eid, phone}], warnings }.
     `nameKeyOf` is injected (ScheduleCore.rosterKey) so this file need not know
     how names are matched across the two identifier namespaces. */
  function fromSheet(aoa, nameKeyOf) {
    var out = { rows: [], warnings: [] };
    var grid = aoa || [];
    var keyOf = nameKeyOf || function (v) { return String(v || '').toLowerCase(); };
    // The header can sit below a title or a merged banner, so the first rows are
    // searched rather than assumed.
    for (var h = 0; h < Math.min(grid.length, 12); h++) {
      var row = (grid[h] || []).map(function (c) { return c == null ? '' : String(c); });
      var phoneCol = headerIndex(row, PHONE_COL);
      if (phoneCol === -1) continue;
      var nameCol = headerIndex(row, NAME_COL);
      var eidCol = headerIndex(row, EID_COL);
      if (nameCol === -1 && eidCol === -1) continue;

      var bad = 0;
      grid.slice(h + 1).forEach(function (r) {
        var cells = r || [];
        var raw = String(cells[phoneCol] == null ? '' : cells[phoneCol]).trim();
        var name = nameCol === -1 ? '' : String(cells[nameCol] == null ? '' : cells[nameCol]).trim();
        var eid = eidCol === -1 ? '' : String(cells[eidCol] == null ? '' : cells[eidCol]).trim();
        if (!raw || (!name && !eid)) return;
        var phone = normalize(raw);
        if (!phone) { bad++; return; }
        out.rows.push({ name: name, nameKey: name ? keyOf(name) : '', eid: eid, phone: phone });
      });
      if (bad) {
        out.warnings.push(bad + ' row(s) had something in the phone column that is not a ' +
          'ten-digit US number, and were skipped rather than guessed at.');
      }
      return out;
    }
    return out;
  }

  /* ---------- the stored shape ----------
     Keyed by badge, like everything else that hangs off a profile. The EID and
     name key are kept so a number harvested from a sheet can be re-matched
     later if the roster changes underneath it. */
  function idFor(fields) {
    var safe = function (v) { return String(v || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60); };
    // Badge first, because a hand-entered number is about one known person. A
    // harvested one may only know a name, and keying it that way lets the next
    // upload of the same sheet update it rather than duplicate it.
    if (fields.badge) return 'PH-' + safe(fields.badge);
    if (fields.eid) return 'PH-eid-' + safe(fields.eid);
    return 'PH-name-' + safe(fields.nameKey);
  }
  function record(fields, actor, now) {
    var when = (now && typeof now.toISOString === 'function') ? now : new Date();
    var badge = String(fields.badge || '');
    return {
      id: idFor(fields),
      badge: badge,
      phone: normalize(fields.phone),
      name: String(fields.name || '').trim(),
      eid: String(fields.eid || ''),
      nameKey: String(fields.nameKey || ''),
      source: String(fields.source || 'Entered by hand'),
      updatedAt: when.toISOString(),
      updatedBy: actor ? actor.name : ''
    };
  }

  /* Three ways to reach a stored number, because a harvested one may know only
     a name while a hand-entered one knows the badge. Kept as separate maps
     rather than one merged key so the caller can decide which wins -- and it
     should be the badge, since that is the one somebody chose deliberately. */
  function index(records, normBadge) {
    var norm = normBadge || function (v) { return String(v == null ? '' : v).trim(); };
    var out = { byBadge: new Map(), byEid: new Map(), byName: new Map() };
    (records || []).forEach(function (r) {
      if (!r || !r.phone) return;
      if (r.badge) out.byBadge.set(norm(r.badge), r);
      if (r.eid) out.byEid.set(String(r.eid).toUpperCase(), r);
      if (r.nameKey) {
        // A name shared by two people cannot pick between them.
        out.byName.set(r.nameKey, out.byName.has(r.nameKey) &&
          out.byName.get(r.nameKey).phone !== r.phone ? null : r);
      }
    });
    return out;
  }
  /* The number for a profile, best key first. Returns the record, so the caller
     can show where it came from -- a number matched on a name is worth less
     confidence than one somebody typed against a badge. */
  function lookup(ix, profile, nameKeyOf) {
    if (!ix || !profile) return null;
    var hit = ix.byBadge.get(profile.badge);
    if (hit) return hit;
    /* The TIMECLOCK id, not the EID. Numbers harvested from the workbook are
       filed under the id in its column headed "EID" -- which is the WFM one,
       not RC's Legacy Contact ID that the team searches by. Two numbers, one
       overloaded word; reading profile.empNumber here would match nothing. */
    if (profile.timeclockId) {
      hit = ix.byEid.get(String(profile.timeclockId).toUpperCase());
      if (hit) return hit;
    }
    var k = nameKeyOf ? nameKeyOf(profile.name) : '';
    return (k && ix.byName.get(k)) || null;
  }

  /* Matching harvested rows onto profiles. The EID is exact where both sides
     have one; the name is the fallback, and a name that reaches two different
     profiles is left alone rather than assigned to whichever came first --
     ringing the wrong person is the failure this is trying to avoid. */
  function matchToProfiles(rows, profiles, opts) {
    opts = opts || {};
    var keyOf = opts.nameKeyOf || function (v) { return String(v || '').toLowerCase(); };
    var byEid = new Map(), byName = new Map();
    profiles.forEach(function (p) {
      if (p.timeclockId) byEid.set(String(p.timeclockId).toUpperCase(), p);
      var k = keyOf(p.name);
      if (!k) return;
      byName.set(k, byName.has(k) ? null : p);   // poisoned on a duplicate
    });
    var matched = [], unmatched = [], ambiguous = [];
    (rows || []).forEach(function (r) {
      var p = r.eid ? byEid.get(String(r.eid).toUpperCase()) : null;
      if (!p && r.nameKey) {
        if (byName.has(r.nameKey) && byName.get(r.nameKey) === null) { ambiguous.push(r); return; }
        p = byName.get(r.nameKey) || null;
      }
      if (!p) { unmatched.push(r); return; }
      matched.push({ profile: p, row: r });
    });
    return { matched: matched, unmatched: unmatched, ambiguous: ambiguous };
  }

  var api = {
    normalize: normalize,
    isValid: isValid,
    format: format,
    e164: e164,
    fromSheet: fromSheet,
    record: record,
    index: index,
    lookup: lookup,
    idFor: idFor,
    matchToProfiles: matchToProfiles,
    NAME_COL: NAME_COL,
    PHONE_COL: PHONE_COL
  };
  root.ContactsCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
