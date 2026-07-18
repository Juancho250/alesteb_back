const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const ignoredDirs = new Set(['.git', 'node_modules', 'coverage', 'dist', 'build', 'tmp', 'temp']);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        files.push(...walk(fullPath));
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

const files = walk(repoRoot).sort();
let failures = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures += 1;
    console.error(`Syntax check failed: ${path.relative(repoRoot, file)}`);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.stdout) process.stdout.write(result.stdout);
  }
}

if (failures > 0) {
  console.error(`Lint failed for ${failures} file(s).`);
  process.exit(1);
}

console.log(`Syntax OK for ${files.length} JavaScript file(s).`);
