import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Usage: node run-review.mjs <clean-checkout> <frontend|backend> <evidence-directory>
const [checkout, mode, evidence] = process.argv.slice(2);
if (!checkout || !['frontend', 'backend'].includes(mode) || !evidence) throw new Error('Missing arguments');
fs.mkdirSync(evidence, { recursive: true });
const results = [];
function run(executable, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(executable, args, { cwd, env, windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, durationMs: Date.now() - start, output }));
  });
}
if (mode === 'frontend') {
  const files = [
    'src/components/__tests__/SyncStatusBadge.mobile.test.tsx',
    'src/components/settings/__tests__/ServerConnectionSettings.test.tsx',
    'src/components/__tests__/removedConnectionFeatures.test.ts',
    'src/lib/__tests__/androidImmersiveEditorContract.test.ts',
    'src/hooks/__tests__/useAttachmentVideoRenderSource.test.tsx',
    'src/lib/__tests__/proxyCompatibility.test.ts',
    'src/components/__tests__/ShareModalClipboard.test.ts',
    'src/components/__tests__/LoginPageLocalDesktopLogin.test.tsx',
    'src/lib/encryptedNotes/__tests__/cryptoV2.test.ts',
  ];
  for (let round = 1; round <= 3; round++) {
    for (const file of round === 1 ? files : files.slice(5)) {
      const label = path.basename(file).replace(/\.(tsx|ts)$/, '') + '-r' + round;
      const jsonPath = path.join(evidence, label + '.json');
      const args = [path.join(checkout, 'frontend/node_modules/vitest/vitest.mjs'), 'run', file, '--maxWorkers=1', '--minWorkers=1', '--reporter=json', '--outputFile=' + jsonPath];
      const result = await run(process.execPath, args, path.join(checkout, 'frontend'));
      fs.writeFileSync(path.join(evidence, label + '.log'), result.output);
      const json = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null;
      results.push({ file, round, command: [process.execPath, ...args], code: result.code, durationMs: result.durationMs, total: json?.numTotalTests, passed: json?.numPassedTests, failed: json?.numFailedTests });
      console.log(JSON.stringify(results.at(-1)));
      fs.writeFileSync(path.join(evidence, 'frontend-reruns.json'), JSON.stringify(results, null, 2));
    }
  }
} else {
  // This script must itself run under Electron run-as-node, matching native SQLite ABI.
  const { runTestFile } = await import(pathToFileURL(path.join(checkout, 'backend/scripts/run-tests-serial.mjs')));
  const files = process.env.QA_BACKEND_FILES?.split(',') || ['plugin-studio-projects', 'note-delete-attachments', 'attachment-modern-media', 'attachments-router-bootstrap', 'encrypted-notes-upgrade', 'automation-platform'];
  for (const file of files) {
    const result = await runTestFile(path.join(checkout, 'backend/tests', file + '.test.ts'), file);
    fs.writeFileSync(path.join(evidence, file + '.log'), result.stdout + '\n' + result.stderr);
    const { stdout, stderr, ...summary } = result;
    results.push({ ...summary, executable: process.execPath, node: process.version, abi: process.versions.modules });
    console.log(JSON.stringify(results.at(-1)));
    fs.writeFileSync(path.join(evidence, 'backend-reruns.json'), JSON.stringify(results, null, 2));
  }
}
process.exitCode = results.some((result) => result.code !== 0 || (result.status && result.status !== 'passed')) ? 1 : 0;
