import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const [reportRoot, checkout] = process.argv.slice(2);
const evidence = path.join(reportRoot, 'evidence');
const read = (relative) => JSON.parse(fs.readFileSync(path.join(evidence, relative), 'utf8'));
const baseline = read('baseline.json');
const front = read('frontend-reruns.json');
const backend = ['', 'backend-rest/', 'backend-related/'].flatMap((dir) => read(dir + 'backend-reruns.json').map((row) => {
  const log = fs.readFileSync(path.join(evidence, dir, row.label + '.log'), 'utf8');
  const count = (name) => Number(log.match(new RegExp('^# ' + name + ' (\\d+)$', 'm'))?.[1] || 0);
  return { ...row, evidence: 'evidence/' + dir + row.label + '.log', total: count('tests'), passed: count('pass'), failed: count('fail') };
}));
const summary = { schemaVersion: 1, date: '2026-10-12', timezone: 'Asia/Shanghai', testedSha: baseline.targetSha, releaseDecision: 'NO-GO', businessCodeModified: false, previousReports: { independentRawLogsAvailable: false, frontendClaim: { total: 3622, passed: 3608, failed: 14 }, backendFileClaim: { total: 342, passed: 337, nonPass: 5 } }, frontend: { firstRound: front.filter(row => row.round === 1), repeatedRounds: front.filter(row => row.round > 1), firstRoundTotals: front.filter(row => row.round === 1).reduce((sum,row) => ({total:sum.total+row.total,passed:sum.passed+row.passed,failed:sum.failed+row.failed}),{total:0,passed:0,failed:0}), historicalCryptoCaseName:'UNKNOWN', fullSuiteRun:false }, backend, additionalFrontend: Object.fromEntries(['production-i18n-render.json','frontend-related.json','address-proof.json'].map(file => { const json=read(file); return [file,{total:json.numTotalTests,passed:json.numPassedTests,failed:json.numFailedTests}]; })), boundaryObservations:'evidence/boundary-audit.json', authenticatedBundleHttp:'evidence/http-bundle-proof.json', platformStatus:{windowsSource:'EXECUTED',backendBundle:'EXECUTED',windowsInstaller:'NOT_TESTED',androidFinalDevice:'BLOCKED',docker:'NOT_TESTED',linuxSandbox:'NOT_TESTED',browserE2E:'NOT_TESTED',exportReimport:'NOT_TESTED'}, unresolvedBugs:[{id:'BUG-02',severity:'P1',status:'REPRODUCED_DATA_SAFETY_CONTRACT'},{id:'BUG-06',severity:'P2_CONDITIONAL_P1',status:'LOCAL_FILESYSTEM_GAP_REMOTE_PREREQUISITES_OPEN'},{id:'BUG-03',severity:'P2',status:'REPRODUCED_NOTNULL_MISCLASSIFICATION'},{id:'BUG-07',severity:'P2',status:'REPRODUCED_DOM'},{id:'BUG-04',severity:'P3',status:'REPRODUCED_404'},{id:'BUG-05',severity:'P3',status:'LIMITED_ROUTER_OBSERVATION'}], withdrawnBug:[{id:'BUG-01',reason:'PRODUCTION_RESOURCES_EXIST_TEST_INITIALIZATION_MISSING'}] };
summary.platformStatus.androidFinalDevice='NOT_TESTED';
summary.androidDeviceState='evidence/android-device-state.json';
fs.writeFileSync(path.join(reportRoot,'test-results.json'),JSON.stringify(summary,null,2));
const gitFiles = execFileSync('git',['-C',checkout,'ls-tree','-r','--name-only','HEAD'],{encoding:'utf8'}).trim().split('\n');
fs.writeFileSync(path.join(reportRoot,'source-inventory.json'),JSON.stringify({sha:baseline.targetSha,routeCodeFiles:gitFiles.filter(file=>file.startsWith('backend/src/routes/')),backendTestFiles:gitFiles.filter(file=>/^backend\/tests\/.*\.test\.ts$/.test(file)),frontendTestFiles:gitFiles.filter(file=>/^frontend\/src\/.*__tests__.*\.(test|spec)\.(ts|tsx)$/.test(file))},null,2));
function walk(directory) { return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(directory,entry.name)):[path.join(directory,entry.name)]); }
const files=walk(reportRoot).filter(file=>path.basename(file)!=='evidence-manifest.json');
const manifest={sha:baseline.targetSha,generatedAt:new Date().toISOString(),files:files.map(file=>{const bytes=fs.readFileSync(file);return {path:path.relative(reportRoot,file).split(path.sep).join('/'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};})};
fs.writeFileSync(path.join(reportRoot,'evidence-manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({front:summary.frontend.firstRoundTotals,backendFiles:backend.length,backendTests:backend.reduce((sum,row)=>sum+row.total,0),archiveFiles:manifest.files.length}));
