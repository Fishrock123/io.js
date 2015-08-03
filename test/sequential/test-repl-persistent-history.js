'use strict';

// Flags: --expose-internals

const common = require('../common');
const stream = require('stream');
const REPL = require('internal/repl');
const assert = require('assert');
const fs = require('fs');
const util = require('util');
const path = require('path');
const os = require('os');

var failed = false;

common.refreshTmpDir();

// Mock os.homedir()
os.homedir = function() {
  return common.tmpDir;
};

// Create an input stream specialized for testing an array of commands
class ArrayStream extends stream.Stream {
  run(data, ctx) {
    this._iter = data[Symbol.iterator]();
    this._ctx = ctx;
    this.consume();
  }
  consume() {
    const self = this;

    function doAction() {
      // if (self.paused = true) return
      const next = self._iter.next();
      if (next.done) {
        // Close the repl. Note that it must have a clean prompt to do so.
        setImmediate(function() {
          self.emit('keypress', '', { ctrl: true, name: 'd' });
        });
        return;
      }
      const action = next.value;

      if (typeof action === 'function') {
        action.call(self._ctx, doAction.bind(this));
      } else if (typeof action === 'object') {
        self.emit('keypress', '', action);
        doAction();
      } else {
        self.emit('data', action + '\n');
        doAction();
      }
    }
    setImmediate(doAction.bind(this));
  }
  resume() {/* this.paused = false; if (this._iter) this.consume() */}
  write() {}
  pause() {/* this.paused = true */}
}
ArrayStream.prototype.readable = true;


// Mock keys
const UP = { name: 'up' };
const ENTER = { name: 'enter' };
const CLEAR = { ctrl: true, name: 'u' };
// Common message bits
const prompt = '> ';
const replDisabled = '\nPersistent history support disabled. Set the ' +
                     'NODE_REPL_HISTORY environment\nvariable to a valid, ' +
                     'user-writable path to enable.\n';
const convertMsg = '\nConverting old JSON repl history to line-separated ' +
                   'history.\nThe new repl history file can be found at ' +
                   path.join(common.tmpDir, '.node_repl_history') + '.\n';
const homedirErr = '\nError: Could not get the home directory.\n' +
                   'REPL session history will not be persisted.\n';
// File paths
const fixtures = path.join(common.testDir, 'fixtures');
const historyFixturePath = path.join(fixtures, '.node_repl_history');
const historyPath = path.join(common.tmpDir, '.fixture_copy_repl_history');
const oldHistoryPath = path.join(fixtures, 'old-repl-history-file.json');


const tests = [{
  env: { NODE_REPL_HISTORY: '' },
  test: [UP],
  expected: [prompt, replDisabled, prompt]
},
{
  env: { NODE_REPL_HISTORY: '',
         NODE_REPL_HISTORY_FILE: oldHistoryPath },
  test: [UP],
  expected: [prompt, replDisabled, prompt]
},
{
  env: { NODE_REPL_HISTORY: historyPath },
  test: [UP, CLEAR],
  expected: [prompt, prompt + '\'you look fabulous today\'', prompt]
},
{
  env: { NODE_REPL_HISTORY: historyPath,
         NODE_REPL_HISTORY_FILE: oldHistoryPath },
  test: [UP, CLEAR],
  expected: [prompt, prompt + '\'you look fabulous today\'', prompt]
},
{
  env: { NODE_REPL_HISTORY: historyPath,
         NODE_REPL_HISTORY_FILE: '' },
  test: [UP, CLEAR],
  expected: [prompt, prompt + '\'you look fabulous today\'', prompt]
},
{
  env: {},
  test: [UP],
  expected: [prompt]
},
{
  env: { NODE_REPL_HISTORY_FILE: oldHistoryPath },
  test: [UP, CLEAR, '\'42\'', ENTER/*, function(cb) {
    // XXX(Fishrock123) Allow the REPL to save to disk.
    // There isn't a way to do this programmatically right now.
    setTimeout(cb, 50);
  }*/],
  expected: [prompt, convertMsg, prompt, prompt + '\'=^.^=\'', prompt, '\'',
             '4', '2', '\'', '\'42\'\n', prompt, prompt],
  after: function ensureHistoryFixture() {
    // XXX(Fishrock123) Make sure nothing weird happened to our fixture.
    // Sometimes this test used to erase it and I'm not sure why.
    const history = fs.readFileSync(historyPath, 'utf8');
    assert.strictEqual(history, '\'you look fabulous today\'' + os.EOL +
                                '\'Stay Fresh~\'' + os.EOL);
  }
},
{
  env: {},
  test: [UP, UP, ENTER],
  expected: [prompt, prompt + '\'42\'', prompt + '\'=^.^=\'', '\'=^.^=\'\n',
             prompt]
},
{ // Make sure this is always the last test, since we change os.homedir()
  env: {},
  test: [UP],
  expected: [prompt, homedirErr, prompt, replDisabled, prompt],
  before: function() {
    // Mock os.homedir() failure
    os.homedir = function() {
      throw new Error('os.homedir() failure');
    };
  }
}];


// Copy our fixture to the tmp directory
fs.createReadStream(historyFixturePath)
  .pipe(fs.createWriteStream(historyPath)).on('unpipe', function() {
    runTest();
  });

function runTest() {
  const opts = tests.shift();
  if (!opts) {
    if (failed) process.exitCode = 1;
    return;
  }

  const env = opts.env;
  const test = opts.test;
  const expected = opts.expected;
  const after = opts.after;
  const before = opts.before;
  // const _expected = expected[Symbol.iterator]()

  if (before) before();

  REPL.createInternalRepl(env, {
    input: new ArrayStream()/*new stream.Readable({
      read() {
        const next = _expected.next()
        if (next.done) {
          this.emit('keypress', '', { meta: true, name: 'd' });
          return
        }
        const action = next.value

        if (typeof action === 'function') {
          action.call(ctx, doAction.bind(this));
          this.push('')
        } else if (typeof action === 'object') {
          this.emit('keypress', '', action);
          this.push('')
        } else {
          this.emit('data', action + '\n');
          this.push('')
        }
      }
    })*/,
    output: new stream.Writable({
      write(chunk, _, next) {
        const output = chunk.toString();

        // Ignore escapes and blank lines
        if (output.charCodeAt(0) === 27 || /^[\r\n]+$/.test(output))
          return next();

        const expectedOutput = expected.shift();
        if (output !== expectedOutput) {
          console.error('ERROR: ' + util.inspect(output, { depth: 0 }) +
                        ' !== ' + util.inspect(expectedOutput, { depth: 0 }));
          console.log('env:', env);
          console.log('test:', test);
          failed = true;
        }
        // assert.strictEqual(output, expectedOutput);
        next();
      }
    }),
    prompt: prompt,
    useColors: false,
    terminal: true
  }, function(err, repl) {
    if (err) throw err;

    if (after) repl.on('close', after);

    repl.on('close', function() {
      // Ensure everything that we expected was output
      if (expected.length !== 0) {
        console.error('ERROR: ' + expected.length + ' !== 0');
        console.error(expected);
        failed = true;
      }
      // assert.strictEqual(expected.length, 0);
      setImmediate(runTest);
    });

    repl.inputStream.run(test, repl);
  });
}
