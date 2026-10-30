import fs from 'node:fs';
import path from 'node:path';
import { runTestFile } from 'file:///C:/Users/cropf/Desktop/UGits/nowen-note/backend/scripts/run-tests-serial.mjs';

const evidence = process.argv[2];
const files = [...new Set(['targeted-backend-files.txt', 'dcc-additional-backend-files.txt']
  .flatMap(name => fs.readFileSync(path.join(evidence, name), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)))].sort();
const results = [];
for (const file of files) {
  const result = await runTestFile('C:/Users/cropf/Desktop/UGits/nowen-note/' + file, path.basename(file));
  fs.writeFileSync(path.join(evidence, 'isolated-' + path.basename(file) + '.log'), result.stdout + '\n' + result.stderr);
  const stat = key => Number(result.stdout.match(new RegExp('^# ' + key + ' (\\d+)$', 'm'))?.[1] ?? 0);
  results.push({ file, status: result.status, exitCode: result.code, tests: stat('tests'), passed: stat('pass'),
    failed: stat('fail'), skipped: stat('skipped'), firstError: result.firstError ?? null });
  fs.writeFileSync(path.join(evidence, 'isolated-backend-results.json'), JSON.stringify(results, null, 2));
  process.stdout.write(JSON.stringify(results.at(-1)) + '\n');
}
const summary = { files: results.length, passedFiles: results.filter(r => r.status === 'passed').length,
  failedFiles: results.filter(r => r.status !== 'passed').length, tests: results.reduce((a, r) => a + r.tests, 0),
  passed: results.reduce((a, r) => a + r.passed, 0), failed: results.reduce((a, r) => a + r.failed, 0),
  skipped: results.reduce((a, r) => a + r.skipped, 0),
  runner: 'backend/scripts/run-tests-serial.mjs runTestFile; tests/setup-db-isolation.ts' };
fs.writeFileSync(path.join(evidence, 'isolated-backend-summary.json'), JSON.stringify(summary, null, 2));
process.stdout.write(JSON.stringify(summary) + '\n');
process.exitCode = summary.failedFiles === 0 ? 0 : 1;
