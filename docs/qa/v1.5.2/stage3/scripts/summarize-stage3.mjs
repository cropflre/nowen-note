import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = path.resolve(process.argv[2] || '.');
const stage = path.join(root, 'docs/qa/v1.5.2/stage3'), evidence = path.join(stage, 'evidence');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (name) => JSON.parse(fs.readFileSync(path.join(evidence, name), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const codeSha = '98d1ddf51791c2eb76262cc6bf7841bc184c0696';
const frontend = read('frontend-full-release.json'), assertions = {};
for (const file of frontend.testResults) for (const test of file.assertionResults) assertions[test.status] = (assertions[test.status] || 0) + 1;
assert.deepEqual(assertions, { passed: 3630 });
const backendTree = git('rev-parse', codeSha + ':backend');
assert.equal(backendTree, git('rev-parse', 'd7e0f9f6:backend'));
const backendLog = fs.readFileSync(path.join(evidence, 'backend-full-final.log'), 'utf8');
assert.ok(backendLog.includes('343 passed, 0 failed, 0 timeout out of 343 files'));
const artifactPaths = ['frontend/android/app/build/outputs/apk/debug/app-debug.apk',
  '.qa152-windows-release/win-unpacked/Nowen Note QA152.exe', 'backend/dist/index.js', 'frontend/dist/index.html'];
const artifact = (file) => ({ path: path.join(root, file), bytes: fs.statSync(path.join(root, file)).size,
  sha256: sha256(fs.readFileSync(path.join(root, file))) });
const assets = artifactPaths.map(artifact);
const packagedBackend = artifact('.qa152-windows-release/win-unpacked/resources/backend/dist/index.js');
assert.equal(packagedBackend.sha256, assets[2].sha256);
assert.equal(artifact('.qa152-windows-release/win-unpacked/resources/frontend/dist/index.html').sha256, assets[3].sha256);
const device = read('device-release-r2/android-native.json');
assert.equal(device.sourceCommit, codeSha); assert.equal(device.activePermanentDeletionRefusedWithRetainedBodyAndOutbox, true);
for (const item of ['browser-release/http-ui.json', 'windows-release-http/http-source.json', 'windows-release-http/http-target.json',
  'windows-release-media.json', 'docker-runtime-release-create.json', 'docker-runtime-release-verify.json']) assert.equal(read(item).result, 'PASS');
const safetyAudit = read('sync-delete-audit-with-restore.json');
assert.equal(safetyAudit.syncHttpStatus, 200); assert.equal(safetyAudit.readAfterStatus, 404);
assert.ok(safetyAudit.restoreFailures.some((failure) => failure.code === 'TRASH_ITEM_NOT_FOUND'));
const results = {
  generatedAt: new Date().toISOString(), codeSha, upstreamSha: '65eda826fefe3e481cbbf19ed261a77f0123c6b6',
  decision: 'NO-GO', blockers: ['BUG-11 Sync V2 active permanent delete bypass', 'Studio directory writer / write-race boundary',
    'Android full GUI, attachment bytes, WAN, ACK fault and upgrade acceptance', 'Signed installer/update and Docker upgrade/rollback acceptance'],
  frontend: { runtime: 'Node 24.19.0', files: frontend.testResults.length, assertions, evidence: 'frontend-full-release.json' },
  backend: { runtime: 'Electron Node 20.18.0 / ABI 130', executedCodeSha: 'd7e0f9f65db67365462fda0b87fa1fbf18285a2d',
    filesPassed: 343, filesFailed: 0, filesTimeout: 0, finalBackendTree: backendTree, exactBackendTreeEqual: true,
    fullRunApplicableToFinalNativeImports: false,
    applicabilityCorrection: 'Backend tests import frontend Native sources. The final Native deletion guard changes four old test prerequisites despite the identical backend tree. See ../stage4/README.md for isolated baseline failures and current scoped reruns.',
    internalSkippedCaseCount: 'not aggregated' },
  dcc: { invariants: 12, testReferences: 116, backendFiles: 10, frontendFiles: 22, mappingOnly: true },
  builds: { backend: 'PASS (unchanged final backend tree)', frontend: 'PASS', sdk: 'PASS', mcp: 'PASS', cli: 'PASS' },
  artifacts: assets, packagedBackendEqualsBuild: true, packagedFrontendIndexEqualsBuild: true,
  apk: JSON.parse(fs.readFileSync(path.join(root, 'frontend/android/app/build/outputs/apk/debug/output-metadata.json'), 'utf8')),
  docker: { image: 'nowen-qa152:98d1ddf5', imageId: 'sha256:307285e3d62cea13d7c726274bf89bd095ff8adf6a76a2dc7e925a25e7d8b540',
    buildInput: 'git -c core.autocrlf=false archive 98d1ddf5; Linux Git blob line endings', acceptance: 'production runtime smoke and restart; not soak/upgrade/rollback' },
  android: { device: device.device, package: device.package, sourceCommit: device.sourceCommit,
    accepted: 'Native SQLite / API Bridge diagnostic entry, real physical device, isolated loopback identity', fullProductMatrix: 'PARTIAL',
    nativeCommitToServerAndAck: device.nativeCommitToServerAndAck, httpPushToNativePull: device.httpPushToNativePull },
  safety: { bug: 'BUG-11', severity: 'P1', status: 'OPEN', evidence: 'sync-delete-audit-with-restore.json',
    activeOwnerSyncDeleteApplied: true, recoveryFailed: true, unauthorizedExploitProven: false },
  originalWorkspace: 'retained existing modifications; no source changes copied back', externalActions: 'no push, PR, merge or release',
};
fs.writeFileSync(path.join(stage, 'results.json'), JSON.stringify(results, null, 2));
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name); return entry.isDirectory() ? files(file) : [file];
  });
}
const manifest = files(evidence).sort().map((file) => ({ path: path.relative(stage, file).replaceAll('\\', '/'),
  bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) }));
fs.writeFileSync(path.join(stage, 'evidence-manifest.json'), JSON.stringify({ codeSha, files: manifest }, null, 2));
console.log(JSON.stringify({ decision: results.decision, codeSha, frontend: assertions, backendFilesPassed: 343, evidenceFiles: manifest.length }));
