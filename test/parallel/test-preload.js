'use strict';
const common = require('../common');
const assert = require('assert');
const path = require('path');
const child_process = require('child_process');

const nodeBinary = process.argv[0];

const preloadOption = function(preloads) {
  var option = '';
  preloads.forEach(function(preload, index) {
    option += '-r ' + preload + ' ';
  });
  return option;
};

const fixture = function(name) {
  return path.join(__dirname, '../fixtures/' + name);
};

const fixtureA = fixture('printA.js');
const fixtureB = fixture('printB.js');
const fixtureC = fixture('printC.js');
const fixtureD = fixture('define-global.js');
const fixtureThrows = fixture('throws_error4.js');

// test preloading a single module works
child_process.exec(nodeBinary + ' '
  + preloadOption([fixtureA]) + ' '
  + fixtureB,
  function(err, stdout, stderr) {
    if (err) throw err;
    assert.equal(stdout, 'A\nB\n');
  });

// test preloading multiple modules works
child_process.exec(nodeBinary + ' '
  + preloadOption([fixtureA, fixtureB]) + ' '
  + fixtureC,
  function(err, stdout, stderr) {
    if (err) throw err;
    assert.equal(stdout, 'A\nB\nC\n');
  });

// test that preloading a throwing module aborts
child_process.exec(nodeBinary + ' '
  + preloadOption([fixtureA, fixtureThrows]) + ' '
  + fixtureB,
  function(err, stdout, stderr) {
    if (err) {
      assert.equal(stdout, 'A\n');
    } else {
      throw new Error('Preload should have failed');
    }
  });

// test that preload can be used with --eval
child_process.exec(nodeBinary + ' '
  + preloadOption([fixtureA])
  + '-e "console.log(\'hello\');"',
  function(err, stdout, stderr) {
    if (err) throw err;
    assert.equal(stdout, 'A\nhello\n');
  });

// test that preload can be used with stdin
const stdin_proc = child_process.spawn(
  nodeBinary,
  ['--require', fixtureA],
  {stdio: 'pipe'}
);
stdin_proc.stdin.end('console.log(\'hello\');');
var stdin_stdout = '';
stdin_proc.stdout.on('data', function(d) {
  stdin_stdout += d;
});
stdin_proc.on('exit', function(code) {
  assert.equal(code, 0);
  assert.equal(stdin_stdout, 'A\nhello\n');
});

// test that preload can be used with repl
const repl_proc = child_process.spawn(
  nodeBinary,
  ['-i', '--require', fixtureA],
  {stdio: 'pipe'}
);
repl_proc.stdin.end('.exit\n');
var repl_stdout = '';
repl_proc.stdout.on('data', function(d) {
  repl_stdout += d;
});
repl_proc.on('exit', function(code) {
  assert.equal(code, 0);
  const output = [
    'A',
    '> '
  ].join('\n');
  assert.equal(repl_stdout, output);
});

// test that preload placement at other points in the cmdline
// also test that duplicated preload only gets loaded once
child_process.exec(nodeBinary + ' '
  + preloadOption([fixtureA])
  + '-e "console.log(\'hello\');" '
  + preloadOption([fixtureA, fixtureB]),
  function(err, stdout, stderr) {
    if (err) throw err;
    assert.equal(stdout, 'A\nB\nhello\n');
  });

// test that preload works with -i
const interactive = child_process.exec(nodeBinary + ' '
  + preloadOption([fixtureD])
  + '-i',
  common.mustCall(function(err, stdout, stderr) {
    assert.ifError(err);
    assert.strictEqual(stdout, `> 'test'\n> `);
  }));

interactive.stdin.write('a\n');
interactive.stdin.write('process.exit()\n');

child_process.exec(nodeBinary + ' '
  + '--require ' + fixture('cluster-preload.js') + ' '
  + fixture('cluster-preload-test.js'),
  function(err, stdout, stderr) {
    if (err) throw err;
    assert.ok(/worker terminated with code 43/.test(stdout));
  });

// https://github.com/nodejs/node/issues/1691
process.chdir(path.join(__dirname, '../fixtures/'));
child_process.exec(nodeBinary + ' '
  + '--expose_debug_as=v8debug '
  + '--require ' + fixture('cluster-preload.js') + ' '
  + 'cluster-preload-test.js',
  function(err, stdout, stderr) {
    if (err) throw err;
    assert.ok(/worker terminated with code 43/.test(stdout));
  });
