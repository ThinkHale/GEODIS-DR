/* GEODIS Management Suite -- optimistic mutation state.
 *
 * A control should never look finished while its write is still in flight, and
 * a failed optimistic write should never leave the unsaved value on screen.
 * This module owns those transitions without touching the DOM, starting timers
 * or performing a request.  Undo returns a compensating-action descriptor for
 * the caller to execute; the result of that request comes back through the same
 * succeed/fail transitions as an ordinary save.
 */
(function (root, factory) {
  var api = factory();
  root.MutationCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var IDLE = 'idle';
  var SAVING = 'saving';
  var SAVED = 'saved';
  var ERROR = 'error';
  var SAVE = 'save';
  var UNDO = 'undo';
  var DEFAULT_UNDO_MS = 5000;

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function plain(value, fallback, max) {
    var text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (!text) text = fallback || '';
    return text.slice(0, max || 300).trim();
  }

  function sentenceLabel(value) {
    var label = plain(value, 'change', 100);
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function normalizeError(error) {
    var source = error || {};
    var message = typeof error === 'string' ? error : source.message;
    var out = {
      name: plain(source.name, 'Error', 80),
      message: plain(message, 'The change could not be saved.', 300)
    };
    if (source.status != null && isFinite(Number(source.status))) out.status = Number(source.status);
    if (source.code != null) out.code = plain(source.code, '', 100);
    return out;
  }

  function toMillis(value) {
    if (value && typeof value.getTime === 'function') value = value.getTime();
    else if (typeof value === 'string') value = Date.parse(value);
    value = Number(value);
    if (!isFinite(value)) throw new TypeError('The mutation clock must return a valid date or millisecond value.');
    return value;
  }

  function iso(ms) { return new Date(ms).toISOString(); }

  function duration(value, fallback) {
    if (value == null) return fallback;
    var number = Number(value);
    return isFinite(number) && number >= 0 ? number : fallback;
  }

  function createMachine(config) {
    config = config || {};
    var clock = typeof config.clock === 'function' ? config.clock : function () { return Date.now(); };
    var defaultUndoMs = duration(config.undoMs, DEFAULT_UNDO_MS);
    var defaultLabel = plain(config.label, 'change', 100);

    function readTime(options) {
      return toMillis(options && own(options, 'at') ? options.at : clock());
    }

    function initial(value, options) {
      options = options || {};
      return {
        status: IDLE,
        operation: '',
        value: value,
        previousValue: undefined,
        attemptedValue: undefined,
        label: plain(options.label, defaultLabel, 100),
        error: null,
        revision: 0,
        startedAt: '',
        savedAt: '',
        failedAt: '',
        undoUntil: '',
        undoMs: duration(options.undoMs, defaultUndoMs),
        compensatingAction: null,
        result: ''
      };
    }

    function current(state, options) {
      if (!options || options.revision == null) return true;
      return Number(options.revision) === Number(state.revision);
    }

    function begin(state, nextValue, options) {
      state = state || initial(undefined);
      options = options || {};
      if (state.status === SAVING) return state;
      var action = own(options, 'compensatingAction') ? options.compensatingAction
        : own(options, 'compensate') ? options.compensate : null;
      return {
        status: SAVING,
        operation: SAVE,
        value: nextValue,
        previousValue: state.value,
        attemptedValue: nextValue,
        label: plain(options.label, state.label || defaultLabel, 100),
        error: null,
        revision: Number(state.revision || 0) + 1,
        startedAt: iso(readTime(options)),
        savedAt: '',
        failedAt: '',
        undoUntil: '',
        undoMs: duration(options.undoMs,
          state.undoMs == null ? defaultUndoMs : state.undoMs),
        compensatingAction: action,
        result: ''
      };
    }

    function succeed(state, options) {
      options = options || {};
      if (!state || state.status !== SAVING || !current(state, options)) return state;
      var at = readTime(options);
      var wasUndo = state.operation === UNDO;
      var hasUndo = !wasUndo && state.compensatingAction != null && state.undoMs > 0;
      return {
        status: SAVED,
        operation: state.operation,
        value: state.attemptedValue,
        previousValue: state.previousValue,
        attemptedValue: state.attemptedValue,
        label: state.label,
        error: null,
        revision: state.revision,
        startedAt: state.startedAt,
        savedAt: iso(at),
        failedAt: '',
        undoUntil: hasUndo ? iso(at + state.undoMs) : '',
        undoMs: state.undoMs,
        compensatingAction: hasUndo ? state.compensatingAction : null,
        result: wasUndo ? 'undone' : 'saved'
      };
    }

    function fail(state, error, options) {
      options = options || {};
      if (!state || state.status !== SAVING || !current(state, options)) return state;
      return {
        status: ERROR,
        operation: state.operation,
        /* For an ordinary save this is the pre-edit value.  During Undo,
           requestUndo deliberately makes it the last saved value, so a failed
           compensating request rolls back the optimistic restoration too. */
        value: state.previousValue,
        previousValue: state.previousValue,
        attemptedValue: state.attemptedValue,
        label: state.label,
        error: normalizeError(error),
        revision: state.revision,
        startedAt: state.startedAt,
        savedAt: '',
        failedAt: iso(readTime(options)),
        undoUntil: '',
        undoMs: state.undoMs,
        compensatingAction: null,
        result: state.operation === UNDO ? 'undo-error' : 'save-error'
      };
    }

    function deadline(state) {
      var at = Date.parse(state && state.undoUntil || '');
      return isFinite(at) ? at : 0;
    }

    function undoAvailableAt(state, at) {
      return !!state && state.status === SAVED && state.operation === SAVE &&
        state.compensatingAction != null && deadline(state) > at;
    }

    function canUndo(state, options) {
      if (!state || state.status !== SAVED || state.operation !== SAVE ||
          state.compensatingAction == null) return false;
      return undoAvailableAt(state, readTime(options));
    }

    function expire(state, options) {
      if (!state || state.status !== SAVED || !state.undoUntil) return state;
      if (undoAvailableAt(state, readTime(options))) return state;
      return Object.assign({}, state, { undoUntil: '', compensatingAction: null });
    }

    function requestUndo(state, options) {
      options = options || {};
      if (!state || state.status !== SAVED || state.operation !== SAVE) {
        return { accepted: false, reason: 'not-saved', state: state, action: null };
      }
      if (state.compensatingAction == null || !state.undoUntil) {
        return { accepted: false, reason: 'unavailable', state: state, action: null };
      }
      var at = readTime(options);
      if (deadline(state) <= at) {
        return {
          accepted: false,
          reason: 'expired',
          state: Object.assign({}, state, { undoUntil: '', compensatingAction: null }),
          action: null
        };
      }
      var next = {
        status: SAVING,
        operation: UNDO,
        /* Restoring is optimistic too.  If its request fails, fail() uses the
           current saved value below as the rollback target. */
        value: state.previousValue,
        previousValue: state.value,
        attemptedValue: state.previousValue,
        label: state.label,
        error: null,
        revision: Number(state.revision || 0) + 1,
        startedAt: iso(at),
        savedAt: state.savedAt,
        failedAt: '',
        undoUntil: '',
        undoMs: state.undoMs,
        compensatingAction: state.compensatingAction,
        result: ''
      };
      return {
        accepted: true,
        reason: '',
        state: next,
        action: state.compensatingAction,
        revision: next.revision
      };
    }

    function secondsLeft(state, options) {
      if (!state || state.status !== SAVED || state.operation !== SAVE ||
          state.compensatingAction == null) return 0;
      var at = readTime(options);
      if (!undoAvailableAt(state, at)) return 0;
      return Math.max(1, Math.ceil((deadline(state) - at) / 1000));
    }

    /* Plain text plus the ARIA semantics needed by the view.  Saving and success
       are polite status updates; failure is an assertive alert.  No markup is
       returned, so callers can assign message with textContent. */
    function feedback(state, options) {
      state = state || initial(undefined);
      var label = plain(state.label, defaultLabel, 100);
      var leading = sentenceLabel(label);
      var message = '';
      var role = 'status';
      var live = 'polite';

      if (state.status === SAVING) {
        message = state.operation === UNDO ? 'Undoing ' + label + '…' : 'Saving ' + label + '…';
      } else if (state.status === SAVED && state.result === 'undone') {
        message = leading + ' restored.';
      } else if (state.status === SAVED) {
        message = leading + ' saved.';
        var seconds = secondsLeft(state, options);
        if (seconds) message += ' Undo available for ' + seconds + ' second' + (seconds === 1 ? '' : 's') + '.';
      } else if (state.status === ERROR) {
        role = 'alert';
        live = 'assertive';
        if (state.operation === UNDO) {
          message = 'Could not undo ' + label + '. Saved value restored.';
        } else {
          message = 'Could not save ' + label + '. Previous value restored.';
        }
        if (state.error && state.error.message) message += ' ' + state.error.message;
      }

      return { message: message, role: role, ariaLive: live, ariaAtomic: true };
    }

    return {
      initial: initial,
      begin: begin,
      succeed: succeed,
      fail: fail,
      canUndo: canUndo,
      requestUndo: requestUndo,
      expire: expire,
      feedback: feedback,
      feedbackText: function (state, options) { return feedback(state, options).message; },
      isBusy: function (state) { return !!state && state.status === SAVING; }
    };
  }

  var defaultMachine = createMachine();
  return {
    IDLE: IDLE,
    SAVING: SAVING,
    SAVED: SAVED,
    ERROR: ERROR,
    SAVE: SAVE,
    UNDO: UNDO,
    DEFAULT_UNDO_MS: DEFAULT_UNDO_MS,
    createMachine: createMachine,
    create: createMachine,
    initial: defaultMachine.initial,
    begin: defaultMachine.begin,
    succeed: defaultMachine.succeed,
    fail: defaultMachine.fail,
    canUndo: defaultMachine.canUndo,
    requestUndo: defaultMachine.requestUndo,
    expire: defaultMachine.expire,
    feedback: defaultMachine.feedback,
    feedbackText: defaultMachine.feedbackText,
    isBusy: defaultMachine.isBusy
  };
});
