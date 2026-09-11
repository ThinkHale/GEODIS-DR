/* LEGO assignment roster exports. The caller supplies profiles already scoped
 * to the signed-in account and the selected market. Shift tags describe the
 * assignment, independently of today's schedule or clock-in status. */
(function (root) {
  'use strict';

  var COLUMNS = ['Associate', 'EID', 'Badge', 'Account', 'Site', 'Market',
    'Shift', 'Shift hours', 'Status'];

  function text(value) { return value == null ? '' : String(value); }
  function trimmed(value) { return text(value).trim(); }
  function compare(a, b) {
    return text(a).localeCompare(text(b), undefined, { numeric: true, sensitivity: 'base' });
  }
  function comparePeople(a, b) {
    return compare(trimmed(a.name), trimmed(b.name)) || compare(a.badge, b.badge);
  }

  function build(profiles, options) {
    options = options || {};
    var status = ['Active', 'Ended', 'all'].indexOf(options.status) === -1 ? 'Active' : options.status;
    var rows = (profiles || []).filter(function (person) {
      return person && /^LEGO\b/i.test(trimmed(person.account)) &&
        (status === 'all' || person.status === status);
    }).sort(comparePeople);
    var byShift = new Map(), unassigned = 0;
    rows.forEach(function (person) {
      var shift = trimmed(person.shift);
      // Keep a missing tag separate even if a real tag is named "Unassigned".
      var key = shift ? 'tag:' + shift.toLowerCase() : 'missing:';
      if (!shift) unassigned++;
      if (!byShift.has(key)) byShift.set(key, { shift: shift || 'Unassigned', rows: [], missing: !shift });
      byShift.get(key).rows.push(person);
    });
    var groups = Array.from(byShift.values()).sort(function (a, b) {
      return (a.missing ? 1 : 0) - (b.missing ? 1 : 0) || compare(a.shift, b.shift);
    }).map(function (group) { return { shift: group.shift, rows: group.rows }; });
    return { rows: rows, groups: groups, unassigned: unassigned };
  }

  function safeSheetName(label, used) {
    var base = trimmed(label).replace(/[\\/\?\*\[\]:\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ').replace(/^'+|'+$/g, '').trim() || 'Shift';
    // Excel limits worksheet names to 31 characters and compares them without
    // case sensitivity. Reserve Summary before naming any shift worksheet.
    var name = base.slice(0, 31).replace(/'+$/g, ''), suffix = 1;
    while (used[name.toLowerCase()]) {
      var tail = ' (' + (++suffix) + ')';
      name = base.slice(0, 31 - tail.length).replace(/'+$/g, '') + tail;
    }
    used[name.toLowerCase()] = true;
    return name;
  }

  function workbook(model, XLSX, metadata) {
    metadata = metadata || {};
    if (!XLSX || !XLSX.utils || typeof XLSX.utils.aoa_to_sheet !== 'function') {
      throw new Error('Excel export is unavailable. Reload the page and try again.');
    }
    var wb = XLSX.utils.book_new();
    var summary = [
      ['LEGO associates by shift'],
      ['Market', metadata.market === 'all' ? 'All markets' : text(metadata.market)],
      ['Status', metadata.status === 'all' ? 'All statuses' : text(metadata.status || 'Active')],
      ['Exported at', text(metadata.exportedAt)],
      ['Roster updated at', text(metadata.rosterUpdatedAt)],
      [],
      ['Shift', 'Associates']
    ];
    model.groups.forEach(function (group) { summary.push([text(group.shift), group.rows.length]); });
    summary.push(['Total', model.rows.length]);
    var overview = XLSX.utils.aoa_to_sheet(summary);
    overview['!cols'] = [{ wch: 28 }, { wch: 34 }];
    overview['!autofilter'] = { ref: 'A7:B' + (7 + model.groups.length) };
    XLSX.utils.book_append_sheet(wb, overview, 'Summary');

    var used = { summary: true };
    model.groups.forEach(function (group) {
      var values = [COLUMNS].concat(group.rows.map(function (person) {
        return [person.name, person.empNumber, person.badge, person.account,
          person.location, person.market, trimmed(person.shift) || 'Unassigned',
          person.shiftHours, person.status].map(text);
      }));
      // SheetJS keeps strings as string cells, preserving leading zeros and
      // formula-looking names without interpreting them as formulas.
      var sheet = XLSX.utils.aoa_to_sheet(values);
      sheet['!cols'] = [30, 15, 15, 22, 12, 18, 16, 36, 14].map(function (width) { return { wch: width }; });
      sheet['!autofilter'] = { ref: 'A1:I' + values.length };
      XLSX.utils.book_append_sheet(wb, sheet, safeSheetName(group.shift, used));
    });
    return wb;
  }

  var api = { build: build, workbook: workbook };
  root.RosterExportCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
