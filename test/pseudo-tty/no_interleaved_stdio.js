// https://github.com/nodejs/node/issues/6456#issuecomment-219320599
// https://gist.github.com/isaacs/1495b91ec66b21d30b10572d72ad2cdd
require('../common');
// 1025 bytes of characters, including end ID and control characters.
// Just enough to overflow the 1kb OS X buffer.
const bytes = 1024 - 21;

var out = new Array(bytes).join('o');
out += 'O'; // End ID character
out = out.replace(/(o{50})/g, '$1\n');

var err = new Array(bytes).join('x');
err += 'X'; // End ID character
err = err.replace(/(x{50})/g, '$1\n');

console.log(out);
console.error(err);
