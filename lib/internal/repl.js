'use strict';

const Interface = require('readline').Interface;
const REPL = require('repl');
const path = require('path');
const fs = require('fs');
const os = require('os');

module.exports = Object.create(REPL);
module.exports.createInternalRepl = createRepl;

// XXX(chrisdickinson): The 15ms debounce value is somewhat arbitrary.
// The debounce is to guard against code pasted into the REPL.
const kDebounceHistoryMS = 15;

// XXX(chrisdickinson): hack to make sure that the internal debugger
// uses the original repl.
function replStart() {
  return REPL.start.apply(REPL, arguments);
}

function createRepl(env, cb) {
  const opts = {
    ignoreUndefined: false,
    terminal: process.stdout.isTTY,
    useGlobal: true
  };

  if (parseInt(env.NODE_NO_READLINE)) {
    opts.terminal = false;
  }
  if (parseInt(env.NODE_DISABLE_COLORS)) {
    opts.useColors = false;
  }

  opts.replMode = {
    'strict': REPL.REPL_MODE_STRICT,
    'sloppy': REPL.REPL_MODE_SLOPPY,
    'magic': REPL.REPL_MODE_MAGIC
  }[String(env.NODE_REPL_MODE).toLowerCase().trim()];

  if (opts.replMode === undefined) {
    opts.replMode = REPL.REPL_MODE_MAGIC;
  }

  const historySize = Number(env.NODE_REPL_HISTORY_SIZE);
  if (!isNaN(historySize) && historySize > 0) {
    opts.historySize = historySize;
  } else {
    // XXX(chrisdickinson): set here to avoid affecting existing applications
    // using repl instances.
    opts.historySize = 1000;
  }

  const repl = REPL.start(opts);
  if (opts.terminal) {
    return setupHistory(repl, env.NODE_REPL_HISTORY_FILE, cb);
  }
  repl._historyPrev = _replHistoryMessage;
  cb(null, repl);
}

function setupHistory(repl, historyPath, ready) {
  // default to using <homedir>/tmp/node_history_file
  if (typeof historyPath !== 'string') {
    const tmpdir = path.join(os.homedir(), 'tmp')
    try {
      fs.mkdirSync(tmpdir);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    historyPath = path.join(tmpdir, 'node_repl_history');
  }

  var timer = null;
  var writing = false;
  var pending = false;
  repl.pause();
  fs.open(historyPath, 'a+', oninit);

  function oninit(err, hnd) {
    if (err) {
      return ready(err);
    }
    fs.close(hnd, onclose);
  }

  function onclose(err) {
    if (err) {
      return ready(err);
    }
    fs.readFile(historyPath, 'utf8', onread);
  }

  function onread(err, data) {
    if (err) {
      return ready(err);
    }
    if (data && data[0] === '['
        // Check the last two characters in case there is a trailing newline
        && /\]/.test(data.substr(-2))) {
      try {
        repl.history = JSON.parse(data);
        if (!Array.isArray(repl.history)) {
          throw new Error('Expected array, got ' + typeof repl.history);
        }
        repl.history.slice(-repl.historySize);

        // update the history file to use plain text
        const historyData = repl.history.join(os.EOL);
        writing = true;
        fs.write(repl._historyHandle, historyData, 'utf8', onwritten);
      } catch (err) {
        return ready(
            new Error(`Could not parse history data in ${historyPath}.`));
      }
    } else {
      repl.history = data.split(os.EOL).slice(-repl.historySize);
    }

    fs.open(historyPath, 'w', onhandle);
  }

  function onhandle(err, hnd) {
    if (err) {
      return ready(err);
    }
    repl._historyHandle = hnd;
    repl.on('line', online);

    // reading the file data out erases it
    repl.once('flushHistory', function() {
      repl.resume();
      ready(null, repl);
    });
    flushHistory();
  }

  // ------ history listeners ------
  function online() {
    repl._flushing = true;

    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(flushHistory, kDebounceHistoryMS);
  }

  function flushHistory() {
    timer = null;
    if (writing) {
      pending = true;
      return;
    }
    writing = true;
    const historyData = repl.history.join(os.EOL);
    fs.write(repl._historyHandle, historyData, 0, 'utf8', onwritten);
  }

  function onwritten(err, data) {
    writing = false;
    if (pending) {
      pending = false;
      online();
    } else {
      repl._flushing = Boolean(timer);
      if (!repl._flushing) {
        repl.emit('flushHistory');
      }
    }
  }
}


function _replHistoryMessage() {
  if (this.history.length === 0) {
    this._writeToOutput(
        '\nPersistent history support disabled. ' +
        'Set the NODE_REPL_HISTORY_FILE environment variable to ' +
        'a valid, user-writable path to enable.\n'
    );
    this._refreshLine();
  }
  this._historyPrev = Interface.prototype._historyPrev;
  return this._historyPrev();
}
