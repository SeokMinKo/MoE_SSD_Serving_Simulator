'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const releaseFiles = Object.freeze([
  'index.html','build-info.js','core.js','help.js','presets.js','config.js','bigmoe-config.js','bigmoe-cache.js','bigmoe-edge.js','bigmoe-telemetry.js','memory.js','colibri.js','compute.js','compute-placement.js','afm.js','storage-io.js','serving.js','serving-device.js','device-experience.js','artifact-v5.js','artifact-v6.js','advisor.js','sweep.js','repro.js','ui.js','render.js','playback.js','token-io.js','ui-shadcn.css','sweep-ui.js','export-ui.js','bigmoe-telemetry-ui.js','tests-init.js','replay-worker.js','simulation-worker.js','package.json','README.md'
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
const buildInfo = `'use strict';\nglobalThis.__MOE_SSD_BUILD__ = Object.freeze({\n  schemaVersion: 'moe-ssd-sim/v4',\n  modelVersion: ${JSON.stringify(pkg.version)},\n  packageVersion: ${JSON.stringify(pkg.version)},\n  commit: ${JSON.stringify(commit)},\n  buildVersion: ${JSON.stringify(buildVersion)}\n});\nif (typeof document === 'object' && typeof document.write === 'function') {\n  document.write('<script src="compute.js"></script><script src="compute-placement.js"></script><script src="serving-device.js"></script><script src="device-experience.js"></script><script src="artifact-v5.js"></script>');\n}\n`;
fs.writeFileSync(path.join(output, 'build-info.js'), buildInfo);
const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
const buildMarker = '<script src="build-info.js"></script>';
const coreMarker = '<script src="core.js"></script>';
if (!html.includes(buildMarker) || !html.includes(coreMarker) || html.indexOf(buildMarker) > html.indexOf(coreMarker)) throw new Error('Release index must load build-info.js before core.js.');
const hashFile = relative => crypto.createHash('sha256').update(fs.readFileSync(path.join(output, relative))).digest('hex');
const bytewisePathCompare = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const manifest = {
  schema: 'moe-ssd-release-manifest/v1',
  commit,
  buildVersion,
  hashAlgorithm: 'sha256',
  serialization: {
    encoding: 'UTF-8',
    jsonIndent: 2,
    lineEnding: 'LF',
    finalLF: true,
    pathOrder: 'UTF-8 bytewise ascending',
    selfReference: 'release-manifest.json and release-manifest.sha256 are excluded from files'
  },
  files: [...releaseFiles].sort(bytewisePathCompare).map(relative => ({ path: relative, sha256: hashFile(relative) }))
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const manifestDigest = crypto.createHash('sha256').update(manifestBytes).digest('hex');
fs.writeFileSync(path.join(output, 'release-manifest.json'), manifestBytes);
fs.writeFileSync(path.join(output, 'release-manifest.sha256'), `${manifestDigest}  release-manifest.json\n`, 'utf8');
process.stdout.write(`${output}\n${commit}\n${buildVersion}\n${manifest.files.length + 2} files\n${manifestDigest}\n`);
