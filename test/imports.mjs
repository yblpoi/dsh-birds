// Dynamically import every module so a broken export or import path fails loudly.
import path from 'node:path';
import fs from 'node:fs';

const root = process.cwd();
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(mjs|js)$/.test(entry.name)) files.push(full);
  }
}
walk(path.join(root, 'lib'));

let bad = 0;
for (const file of files) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  try {
    const mod = await import('file://' + file.split(path.sep).join('/'));
    const names = Object.keys(mod).filter((k) => k !== 'default');
    console.log('OK   ' + relative + '  exports: ' + names.join(', '));
  } catch (error) {
    bad += 1;
    console.log('FAIL ' + relative + ' :: ' + (error?.message ?? error));
  }
}
console.log(bad === 0 ? '\nALL MODULES IMPORT CLEANLY' : '\n' + bad + ' FAILURES');
process.exit(bad === 0 ? 0 : 1);
