'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const releaseFiles = Object.freeze([
  'index.html',
  'build-info.js',
  'core.js',
  'help.js',
  'presets.js',
  'config.js',
  'memory.js',
  'colibri.js',
  'afm.js',
  'storage-io.js',
  'serving.js',
  'advisor.js',
  'sweep.js',
  'repro.js',
  'ui.js',
  'render.js',
  'playback.js',
  'sweep-ui.js',
  'export-ui.js',
  'tests-init.js',
  'replay-worker.js',
  'simulation-worker.js',
  'package.json',
  'README.md'
]);

if (process.argv.length > 2) throw new Error('Release output is fixed to repository dist/.');
if (process.env.MOE_BUILD_COMMIT) throw new Error('MOE_BUILD_COMMIT overrides are forbidden; release identity is derived from Git HEAD.');
const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim();
if (status) throw new Error('Release build requires a clean Git worktree.');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Release provenance requires a full 40-character lowercase Git commit SHA.');

const readCommitted = relative => execFileSync('git', ['show', `${commit}:${relative}`], { cwd: root });
const pkg = JSON.parse(readCommitted('package.json').toString('utf8'));
if (!/^1\.6\.2(?:$|-)/.test(pkg.version)) throw new Error(`Release package version must identify v1.6.2, received ${pkg.version}.`);

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const relative of releaseFiles) {
  const destination = path.join(output, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, readCommitted(relative));
}

const buildVersion = `release/v${pkg.version}+${commit.slice(0, 12)}`;
const buildInfo = `'use strict';\nglobalThis.__MOE_SSD_BUILD__ = Object.freeze({\n  schemaVersion: 'moe-ssd-sim/v4',\n  modelVersion: ${JSON.stringify(pkg.version)},\n  packageVersion: ${JSON.stringify(pkg.version)},\n  commit: ${JSON.stringify(commit)},\n  buildVersion: ${JSON.stringify(buildVersion)}\n});\n`;
fs.writeFileSync(path.join(output, 'build-info.js'), buildInfo);

const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
const buildMarker = '<script src="build-info.js"></script>';
const coreMarker = '<script src="core.js"></script>';
if (!html.includes(buildMarker) || !html.includes(coreMarker) || html.indexOf(buildMarker) > html.indexOf(coreMarker)) {
  throw new Error('Release index must load build-info.js before core.js.');
}

process.stdout.write(`${output}\n${commit}\n${buildVersion}\n`);
