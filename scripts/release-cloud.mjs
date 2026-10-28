#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { CLOUD_REPO, BUILD_WORKFLOW, PUBLISH_WORKFLOW, branch, normalizeBuild, normalizePublish } from './lib/release-cloud-contract.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
export function parseArgs(args) {
  const result = {};
  const flags = { '--wait': 'wait', '--dry-run': 'dryRun', '--help': 'help', '-h': 'help' };
  const values = { '--branch': 'branch', '--sha': 'sha', '--version': 'version', '-v': 'version', '--target': 'targets', '--request-id': 'id', '--publish-run': 'sourceRun', '--attempt': 'attempt', '--notes': 'notes', '--channels': 'channels', '--confirm': 'confirmation' };
  for (let i = 0; i < args.length; i++) {
    if (flags[args[i]]) result[flags[args[i]]] = true;
    else if (values[args[i]] && args[i + 1] && !args[i + 1].startsWith('-')) result[values[args[i]]] = args[++i];
    else throw Error(`未知参数或缺少值：${args[i]}；使用 --help 查看新入口`);
  }
  return result;
}
export async function main(args) {
  const options = parseArgs(args);
  if (options.help || args.length === 0) {
    console.log(`GitHub Actions 发版入口（本机不构建、不改版本、不推 Tag、不上传产物）\n\n构建：bash scripts/release.sh --branch release/v1.5.4 --version 1.5.3 --target pc,android,docker --wait\n发布：bash scripts/release.sh --branch release/v1.5.4 --publish-run RUN_ID --attempt 1 --version 1.5.3 --channels github,docker --confirm 1.5.3\n\n--target: pc / windows / macos / linux / android / ios / store / docker / fpk / upk / clipper / all\n--sha: 固定已提交且推送的分支 HEAD；省略则查询远端\n--request-id: 请求 UUID，重复调用只跟踪同一远端任务\n--wait: 等待远端结果，关闭本机不影响构建\n--dry-run: 只显示请求，不触发 Actions\n版本必须已经提交；Store/NAS 商店上架仍由平台单独处理。`);
    return;
  }
  const requestId = (options.id || randomUUID()).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) throw Error('无效请求 UUID');
  const stateFile = resolve(process.env.NOWEN_RELEASE_DATA || resolve(homedir(), '.nowen-release-center'), 'cli', `${requestId}.json`);
  let previous;
  try { previous = JSON.parse(await readFile(stateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const saved = previous ? JSON.parse(previous.fingerprint) : undefined;
  const ref = branch(options.branch || saved?.ref || execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim());
  const sha = saved?.sha || gh(['api', `repos/${CLOUD_REPO}/branches/${encodeURIComponent(ref)}`, '--jq', '.commit.sha']);
  if (options.sha && options.sha !== sha) throw Error('指定 SHA 与请求固定的远端分支 HEAD 不一致');
  const version = options.version || saved?.inputs.version || JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
  const publish = Boolean(options.sourceRun || saved?.inputs.source_run_id);
  const input = publish ? normalizePublish({ version, request_id: requestId, source_run_id: options.sourceRun || saved?.inputs.source_run_id, source_attempt: options.attempt || saved?.inputs.source_attempt, channels: options.channels || saved?.inputs.channels, confirmation: options.confirmation })
    : normalizeBuild({ version, request_id: requestId, commit_sha: sha, targets: options.targets || saved?.inputs.targets || 'pc', notes: options.notes ?? saved?.inputs.notes ?? '' });
  const id = input.request_id;
  const workflow = publish ? PUBLISH_WORKFLOW : BUILD_WORKFLOW;
  const inputs = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : String(value)]));
  const fingerprint = JSON.stringify({ workflow, ref, sha, inputs });
  if (previous && previous.fingerprint !== fingerprint) throw Error('请求 UUID 已用于其他参数');
  console.log(JSON.stringify({ workflow, ref, inputs }, null, 2));
  if (options.dryRun) return;
  // Persist before dispatch. A lost HTTP response must never cause an automatic second dispatch.
  const find = () => {
    const runs = JSON.parse(gh(['run', 'list', '--repo', CLOUD_REPO, '--workflow', workflow, '--event', 'workflow_dispatch', '--limit', '100', '--json', 'databaseId,displayTitle,headSha,url']));
    const matches = runs.filter(r => r.displayTitle === `Release ${publish ? 'publish' : 'build'} ${id}`);
    if (matches.length > 1) throw Error('发现重复任务，需要在 GitHub 核查');
    if (matches[0] && matches[0].headSha !== sha) throw Error('远端工作流 SHA 与本次请求不一致');
    return matches[0];
  };
  let remote = find();
  if (!remote && !previous) {
    await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
    await writeFile(stateFile, JSON.stringify({ fingerprint }), { flag: 'wx', mode: 0o600 });
  }
  // The marker distinguishes a first dispatch from an uncertain previous invocation.
  if (!remote && !previous) {
    try { execFileSync('gh', ['workflow', 'run', workflow, '--repo', CLOUD_REPO, '--ref', ref, '--json'], { input: JSON.stringify(inputs), stdio: ['pipe', 'inherit', 'inherit'] }); }
    catch { throw Error(`触发结果待核实；请用同一 --request-id ${id} 查询，不要换 UUID 重发`); }
    for (let i = 0; i < 12 && !remote; i++) { await new Promise(resolve => setTimeout(resolve, 2500)); remote = find(); }
  }
  if (!remote) throw Error(`尚未找到 Run；使用相同 --request-id ${id} 重新查询，程序不会再次派发`);
  console.log(`GitHub Actions: ${remote.url}`);
  if (options.wait) execFileSync('gh', ['run', 'watch', String(remote.databaseId), '--repo', CLOUD_REPO, '--exit-status'], { stdio: 'inherit' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
