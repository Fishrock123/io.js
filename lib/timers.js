'use strict';

const Timer = process.binding('timer_wrap').Timer;
const L = require('internal/linkedlist');
const assert = require('assert');
const util = require('util');
const debug = util.debuglog('timer');
const kOnTimeout = Timer.kOnTimeout | 0;

// Timeout values > TIMEOUT_MAX are set to 1.
const TIMEOUT_MAX = 2147483647; // 2^31-1


// HOW and WHY the timers implementation works the way it does.
//
// Since many parts of Node.js and user applications rely on timeouts, there may
// be a very large amount of timeouts scheduled at any given time.
// Therefore, it is very important that the timers implementation is very fast
// and efficient.
//
// Note: It is suggested you first read though the lib/internal/linkedlist.js
// linked list implementation. How it works is somewhat counter-intuitive to
// most JavaScript code, and timers depend on it extensively.
//
// To achieve a high level of efficiency, the implementation is as distributed
// and lazy as possible.
//
// Object maps are kept which contain linked lists keyed by their duration in
// milliseconds.
// The linked lists within are TimerWrap C++ handles with a linked list appended
// to their JavaScript representation.
//
// With this, each list of timers with the same duration reduces the overhead of
// trying to track when all of the timers should timeout by only tracking the
// first timeout, and adjusting to sooner or later timeouts when applicable.
// This technique is described in the libev manual:
// http://pod.tst.eu/http://cvs.schmorp.de/libev/ev.pod#Be_smart_about_timeouts
//
// The timers are distributed into separate lists by milliseconds primarly to
// reduce the impact of the linked list's O(n) (linear) insertion time.


// Object maps containing linked lists of timers, keyed and sorted by their
// duration in milliseconds.
// - key = time in milliseconds
// - value = linked list
const refedLists = {};
const unrefedLists = {};
// The difference between these two objects is that the former contains timers
// that will keep the process open if they are the only thing left, while the
// latter will not.


// Schedule or re-schedule a timer.
// Call this whenever the item is active (not idle).
// The item must have been enroll()'d first.
exports.active = function(item) {
  insert(item, false);
};

// Internal APIs that need timeouts should use `_unrefActive()` instead of
// `active()` so that they do not unnecessarily keep the process open.
exports._unrefActive = function(item) {
  insert(item, true);
};


// The underlying logic for scheduling or re-scheduling a timer.
//
// Inserts a timer into an existing timers list, or creates a new TimerWrap
// backed list if one does not already exist for the specified timeout duration.
function insert(item, unrefed) {
  const msecs = item._idleTimeout;
  if (msecs < 0 || msecs === undefined) return;

  item._idleStart = Timer.now();

  var list;
  const lists = unrefed ? unrefedLists : refedLists;

  // Use an existing list if there is one, otherwise we need to make a new one.
  if (lists[msecs]) {
    list = lists[msecs];
  } else {
    // Make a new linked list of timers.
    // The list object is a TimerWrap, a C++ handle backing the timers for
    // efficiency, and the linked list is appended onto it.
    list = new Timer();
    if (unrefed) list.unref();
    list._unrefed = unrefed;
    list.start(msecs, 0);

    L.init(list);

    lists[msecs] = list;
    list.msecs = msecs;
    list[kOnTimeout] = listOnTimeout;
  }

  L.append(list, item);
  assert(!L.isEmpty(list)); // list is not empty
};

function listOnTimeout() {
  var msecs = this.msecs;
  var list = this;

  debug('timeout callback %d', msecs);

  var now = Timer.now();
  debug('now: %s', now);

  var diff, timer, threw;
  while (timer = L.peek(list)) {
    diff = now - timer._idleStart;

    // Check if this loop iteration is too early for the timer.
    // This happens if one of two things is true:
    // - There are more timers scheduled for later in the list. (Most common)
    // - The earliest timer was canceled (unenrolled). (Less common)
    if (diff < msecs) {
      list.start(msecs - diff, 0);
      debug('%d list wait because diff is %d', msecs, diff);
      return;
    } else {
      // The actual logic for when a timeout happens.

      L.remove(timer);
      assert(timer !== L.peek(list));

      if (!timer._onTimeout) continue;

      var domain = timer.domain;
      if (domain) {

        // v0.4 compatibility: if the timer callback throws and the
        // domain or uncaughtException handler ignore the exception,
        // other timers that expire on this tick should still run.
        //
        // https://github.com/joyent/node/issues/2631
        if (domain._disposed)
          return;

        domain.enter();
      }

      timer._called = true;
      _runOnTimeout(timer, list);

      if (domain)
        domain.exit();
    }
  }

  // If `L.peek(list)` returned nothing, the list was either empty or we have
  // called all of the timer timeouts.
  // As such, we can remove the timer list. (The backing handle)
  debug('%d list empty', msecs);
  assert(L.isEmpty(list));
  list.close();
  if (list._unrefed) {
    delete unrefedLists[msecs];
  } else {
    delete refedLists[msecs];
  }
}


// An optimization so that the try/finally only de-optimizes what is in this
// smaller function.
function _runOnTimeout(timer, list) {
  var threw = true;
  try {
    timer._onTimeout();
    threw = false;
  } finally {
    if (threw) process.nextTick(listOnTimeoutNT, list);
  }
}


function listOnTimeoutNT(list) {
  list[kOnTimeout]();
}


// A convenience function for re-using timer handles (lists) more easily.
//
// This mostly exists to fix https://github.com/nodejs/node/issues/1264.
// Handles in libuv take at least one `uv_run` to be registered as unreferenced.
// Re-using an existing handle allows us to skip that, so that a second `uv_run`
// will return no active handles, even when running `setTimeout(fn).unref()`.
function reuse(item) {
  L.remove(item);

  var list = refedLists[item._idleTimeout];
  // if empty - reuse the watcher
  if (list && L.isEmpty(list)) {
    debug('reuse hit');
    list.stop();
    delete refedLists[item._idleTimeout];
    return list;
  }

  return null;
}


// Remove a timer. Cancels the timeout and resets the relevant timer properties.
const unenroll = exports.unenroll = function(item) {
  var list = reuse(item);
  if (list) {
    debug('unenroll: list empty');
    list.close();
  }
  // if active is called later, then we want to make sure not to insert again
  item._idleTimeout = -1;
};


// Make a regular object able to act as a timer by setting some properties.
// This function does not start the timer, see `active()`.
// Using existing objects as timers slightly reduces object overhead.
exports.enroll = function(item, msecs) {
  if (typeof msecs !== 'number') {
    throw new TypeError('"msecs" argument must be a number');
  }

  if (msecs < 0 || !isFinite(msecs)) {
    throw new RangeError('"msecs" argument must be ' +
                         'a non-negative finite number');
  }

  // if this item was already in a list somewhere
  // then we should unenroll it from that
  if (item._idleNext) unenroll(item);

  // Ensure that msecs fits into signed int32
  if (msecs > TIMEOUT_MAX) {
    msecs = TIMEOUT_MAX;
  }

  item._idleTimeout = msecs;
  L.init(item);
};


/*
 * DOM-style timers
 */


exports.setTimeout = function(callback, after) {
  if (typeof callback !== 'function') {
    throw new TypeError('"callback" argument must be a function');
  }

  after *= 1; // coalesce to number or NaN

  if (!(after >= 1 && after <= TIMEOUT_MAX)) {
    after = 1; // schedule on next tick, follows browser behaviour
  }

  var timer = new Timeout(after);
  var length = arguments.length;
  var ontimeout = callback;
  switch (length) {
    // fast cases
    case 0:
    case 1:
    case 2:
      break;
    case 3:
      ontimeout = () => callback.call(timer, arguments[2]);
      break;
    case 4:
      ontimeout = () => callback.call(timer, arguments[2], arguments[3]);
      break;
    case 5:
      ontimeout =
        () => callback.call(timer, arguments[2], arguments[3], arguments[4]);
      break;
    // slow case
    default:
      var args = new Array(length - 2);
      for (var i = 2; i < length; i++)
        args[i - 2] = arguments[i];
      ontimeout = () => callback.apply(timer, args);
      break;
  }
  timer._onTimeout = ontimeout;

  if (process.domain) timer.domain = process.domain;

  exports.active(timer);

  return timer;
};


exports.clearTimeout = function(timer) {
  if (timer && (timer[kOnTimeout] || timer._onTimeout)) {
    timer[kOnTimeout] = timer._onTimeout = null;
    if (timer instanceof Timeout) {
      timer.close(); // for after === 0
    } else {
      exports.unenroll(timer);
    }
  }
};


exports.setInterval = function(callback, repeat) {
  if (typeof callback !== 'function') {
    throw new TypeError('"callback" argument must be a function');
  }

  repeat *= 1; // coalesce to number or NaN

  if (!(repeat >= 1 && repeat <= TIMEOUT_MAX)) {
    repeat = 1; // schedule on next tick, follows browser behaviour
  }

  var timer = new Timeout(repeat);
  var length = arguments.length;
  var ontimeout = callback;
  switch (length) {
    case 0:
    case 1:
    case 2:
      break;
    case 3:
      ontimeout = () => callback.call(timer, arguments[2]);
      break;
    case 4:
      ontimeout = () => callback.call(timer, arguments[2], arguments[3]);
      break;
    case 5:
      ontimeout =
        () => callback.call(timer, arguments[2], arguments[3], arguments[4]);
      break;
    default:
      var args = new Array(length - 2);
      for (var i = 2; i < length; i += 1)
        args[i - 2] = arguments[i];
      ontimeout = () => callback.apply(timer, args);
      break;
  }
  timer._onTimeout = wrapper;
  timer._repeat = ontimeout;

  if (process.domain) timer.domain = process.domain;
  exports.active(timer);

  return timer;

  function wrapper() {
    timer._repeat();

    // Timer might be closed - no point in restarting it
    if (!timer._repeat)
      return;

    // If timer is unref'd (or was - it's permanently removed from the list.)
    if (this._handle) {
      this._handle.start(repeat, 0);
    } else {
      timer._idleTimeout = repeat;
      exports.active(timer);
    }
  }
};


exports.clearInterval = function(timer) {
  if (timer && timer._repeat) {
    timer._repeat = null;
    clearTimeout(timer);
  }
};


const Timeout = function(after) {
  this._called = false;
  this._idleTimeout = after;
  this._idlePrev = this;
  this._idleNext = this;
  this._idleStart = null;
  this._onTimeout = null;
  this._repeat = null;
};


function unrefdHandle() {
  this.owner._onTimeout();
  if (!this.owner._repeat)
    this.owner.close();
}


Timeout.prototype.unref = function() {
  if (this._handle) {
    this._handle.unref();
  } else if (typeof(this._onTimeout) === 'function') {
    var now = Timer.now();
    if (!this._idleStart) this._idleStart = now;
    var delay = this._idleStart + this._idleTimeout - now;
    if (delay < 0) delay = 0;

    // Prevent running cb again when unref() is called during the same cb
    if (this._called && !this._repeat) {
      exports.unenroll(this);
      return;
    }

    var handle = reuse(this);

    this._handle = handle || new Timer();
    this._handle.owner = this;
    this._handle[kOnTimeout] = unrefdHandle;
    this._handle.start(delay, 0);
    this._handle.domain = this.domain;
    this._handle.unref();
  }
  return this;
};

Timeout.prototype.ref = function() {
  if (this._handle)
    this._handle.ref();
  return this;
};

Timeout.prototype.close = function() {
  this._onTimeout = null;
  if (this._handle) {
    this._handle[kOnTimeout] = null;
    this._handle.close();
  } else {
    exports.unenroll(this);
  }
  return this;
};


var immediateQueue = {};
L.init(immediateQueue);


function processImmediate() {
  var queue = immediateQueue;
  var domain, immediate;

  immediateQueue = {};
  L.init(immediateQueue);

  while (L.isEmpty(queue) === false) {
    immediate = L.shift(queue);
    domain = immediate.domain;

    if (domain)
      domain.enter();

    var threw = true;
    try {
      immediate._onImmediate();
      threw = false;
    } finally {
      if (threw) {
        if (!L.isEmpty(queue)) {
          // Handle any remaining on next tick, assuming we're still
          // alive to do so.
          while (!L.isEmpty(immediateQueue)) {
            L.append(queue, L.shift(immediateQueue));
          }
          immediateQueue = queue;
          process.nextTick(processImmediate);
        }
      }
    }

    if (domain)
      domain.exit();
  }

  // Only round-trip to C++ land if we have to. Calling clearImmediate() on an
  // immediate that's in |queue| is okay. Worst case is we make a superfluous
  // call to NeedImmediateCallbackSetter().
  if (L.isEmpty(immediateQueue)) {
    process._needImmediateCallback = false;
  }
}


function Immediate() { }

Immediate.prototype.domain = undefined;
Immediate.prototype._onImmediate = undefined;
Immediate.prototype._idleNext = undefined;
Immediate.prototype._idlePrev = undefined;


exports.setImmediate = function(callback, arg1, arg2, arg3) {
  if (typeof callback !== 'function') {
    throw new TypeError('"callback" argument must be a function');
  }

  var i, args;
  var len = arguments.length;
  var immediate = new Immediate();

  L.init(immediate);

  switch (len) {
    // fast cases
    case 0:
    case 1:
      immediate._onImmediate = callback;
      break;
    case 2:
      immediate._onImmediate = function() {
        callback.call(immediate, arg1);
      };
      break;
    case 3:
      immediate._onImmediate = function() {
        callback.call(immediate, arg1, arg2);
      };
      break;
    case 4:
      immediate._onImmediate = function() {
        callback.call(immediate, arg1, arg2, arg3);
      };
      break;
    // slow case
    default:
      args = new Array(len - 1);
      for (i = 1; i < len; i++)
        args[i - 1] = arguments[i];

      immediate._onImmediate = function() {
        callback.apply(immediate, args);
      };
      break;
  }

  if (!process._needImmediateCallback) {
    process._needImmediateCallback = true;
    process._immediateCallback = processImmediate;
  }

  if (process.domain)
    immediate.domain = process.domain;

  L.append(immediateQueue, immediate);

  return immediate;
};


exports.clearImmediate = function(immediate) {
  if (!immediate) return;

  immediate._onImmediate = undefined;

  L.remove(immediate);

  if (L.isEmpty(immediateQueue)) {
    process._needImmediateCallback = false;
  }
};
