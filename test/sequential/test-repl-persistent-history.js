'use strict';

// Flags: --expose-internals

const common = require('../common')
const stream = require('stream');
const REPL = require('internal/repl');
const assert = require('assert')
const fs = require('fs')
const util = require('util')

common.refreshTmpDir();

// Mock os.homedir()
require('os').homedir = function() {
  return common.tmpDir;
}

// Create an input stream specialized for testing an array of commands
class ArrayStream extends stream.Stream {
  run(data, ctx) {
    this._iter = data[Symbol.iterator]()
    this._ctx = ctx
    this.consume()
  }
  consume() {
    const self = this;

    function doAction() {
      // if (self.paused = true) return
      const next = self._iter.next()
      if (next.done) {
        // close the repl
        setImmediate(function(){
          self.emit('keypress', '', { ctrl: true, name: 'd' });
        })
        return
      }
      const action = next.value

      if (typeof action === 'function') {
        action.call(self._ctx, doAction.bind(this));
      } else if (typeof action === 'object') {
        self.emit('keypress', '', action);
        doAction()
      } else {
        self.emit('data', action + '\n');
        doAction()
      }
    }
    setImmediate(doAction.bind(this))
  }
  resume() {/* this.paused = false; if (this._iter) this.consume() */}
  write() {}
  pause() {/* this.paused = true */}
}
ArrayStream.prototype.readable = true;


// Mock keys
const UP = { name: 'up' };
const ENTER = { name: 'enter' };
const CLEAR = { ctrl: true, name: 'u' }
// Common message bits
const prompt = '> '
const replDisabled = '\nPersistent history support disabled. Set the NODE_REPL_HISTORY environment\nvariable to a valid, user-writable path to enable.\n'
const convertMsg = '\nConverting old JSON repl history to line-separated history.\nThe new repl history file can be found at ' + common.tmpDir + '/.node_repl_history.\n'


const tests = [{
  env: { NODE_REPL_HISTORY: '' },
  test: [UP],
  expected: [prompt, replDisabled, prompt]
},
{
  env: { NODE_REPL_HISTORY: '',
         NODE_REPL_HISTORY_FILE: common.testDir + '/fixtures/old-repl-history-file.json' },
  test: [UP],
  expected: [prompt, replDisabled, prompt]
},
{
  env: { NODE_REPL_HISTORY: common.testDir + '/fixtures/.node_repl_history' },
  test: [UP, CLEAR],
  expected: [prompt, prompt + '\'you look fabulous today\'', prompt]
},
{
  env: { NODE_REPL_HISTORY: common.testDir + '/fixtures/.node_repl_history',
         NODE_REPL_HISTORY_FILE: common.testDir + '/fixtures/old-repl-history-file.json' },
  test: [UP, CLEAR],
  expected: [prompt, prompt + '\'you look fabulous today\'', prompt]
},
{
  env: { NODE_REPL_HISTORY: common.testDir + '/fixtures/.node_repl_history',
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
  env: { NODE_REPL_HISTORY_FILE: common.testDir + '/fixtures/old-repl-history-file.json' },
  test: [UP, CLEAR, '\'42\'', ENTER, function(cb) {
    setTimeout(cb, 50)
  }],
  expected: [prompt, convertMsg, prompt, prompt + '\'=^.^=\'', prompt,
   '\'', '4', '2', '\'', '\'42\'\n', prompt, prompt],
  after: function ensureFixtureHistory() {
    // XXX(Fishrock123) make sure nothing weird happened to our fixture.
    // Sometimes this test used to erase it and I'm not sure why.
    const history = fs.readFileSync(common.testDir +
                                    '/fixtures/.node_repl_history', 'utf8');
    assert.strictEqual(history,
                       '\'you look fabulous today\'\n\'Stay Fresh~\'\n');
  }
},
{
  env: {},
  test: [UP, UP, ENTER],
  expected: [prompt, prompt + '\'42\'', prompt + '\'=^.^=\'', '\'=^.^=\'\n', prompt]
}]


runTest()
function runTest() {
  const opts = tests.shift()
  if (!opts) return;

  const env = opts.env
  const test = opts.test
  const expected = opts.expected
  const after = opts.after
  // const _expected = expected.slice(0)[Symbol.iterator]()

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
        const output = chunk.toString()

        // ignore escapes and blank lines
        if (output.charCodeAt(0) === 27 || /^[\r\n]+$/.test(output))
          return next();

        const expectedOutput = expected.shift()
        if (output !== expectedOutput) {
          console.error('ERROR: ' + util.inspect(output, { depth: 0 }) + ' !== ' +
                        util.inspect(expectedOutput, { depth: 0 }))
          console.log('env:', env)
          console.log('test:', test)
        }
        // assert.strictEqual(output, expectedOutput);
        next();
      }
    }),
    prompt: prompt,
    useColors: false,
    terminal: true
  }, function(err, repl) {
    if (err) throw err

    if (after) repl.on('close', after)
    repl.on('close', function() {
      if (expected.length !== 0) {
        console.error('ERROR: ' + expected.length + ' !== 0')
        console.error(expected)
      }
      assert.strictEqual(expected.length, 0)
      setImmediate(runTest)
    })

      repl.inputStream.run(test, repl)
  })
}
