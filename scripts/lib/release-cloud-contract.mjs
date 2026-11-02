export const CLOUD_REPO = 'cropflre/nowen-note';
export const BUILD_WORKFLOW = 'release-build.yml';
export const PUBLISH_WORKFLOW = 'release-publish.yml';
export const BUILD_TARGETS = ['windows', 'macos', 'linux', 'android', 'ios', 'store', 'docker', 'fpk', 'upk', 'clipper'];
export const PUBLISH_CHANNELS = ['github', 'docker', 'testflight'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function version(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw Error('版本必须为 X.Y.Z');
  return value;
}
export function branch(value) {
  if (typeof value !== 'string' || !/^(main|release\/[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(value)) throw Error('请选择 main 或 release/* 分支');
  return value;
}
function identity(input) {
  if (typeof input.request_id !== 'string' || !uuid.test(input.request_id)) throw Error('无效请求 UUID');
  return { version: version(input.version), request_id: input.request_id.toLowerCase() };
}
function selection(value, allowed) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  if (!items.length || items.length > 20 || items.some(item => !allowed.includes(item))) throw Error('无效目标选择');
  return [...new Set(items)];
}
export function normalizeBuild(input) {
  const result = identity(input);
  if (!/^[a-f0-9]{40}$/.test(input.commit_sha || '')) throw Error('需要完整 Commit SHA');
  const notes = input.notes ?? '';
  if (typeof notes !== 'string' || notes.length > 10000) throw Error('发布说明最多 10000 字符');
  const aliases = { pc: ['windows', 'macos', 'linux'], lite: ['windows'], 'linux-app': ['linux'], all: BUILD_TARGETS };
  const raw = selection(input.targets, [...BUILD_TARGETS, ...Object.keys(aliases)]);
  const selected = new Set(raw.flatMap(item => aliases[item] || [item]));
  if (selected.has('fpk') || selected.has('upk')) selected.add('docker');
  return { ...result, commit_sha: input.commit_sha, notes, targets: BUILD_TARGETS.filter(item => selected.has(item)) };
}
export function normalizePublish(input) {
  const result = identity(input);
  if (input.confirmation !== result.version) throw Error('请输入准确版本号确认发布');
  const source_run_id = Number(input.source_run_id), source_attempt = Number(input.source_attempt);
  if (!Number.isSafeInteger(source_run_id) || source_run_id < 1 || !Number.isSafeInteger(source_attempt) || source_attempt < 1) throw Error('需要构建 Run ID 和 attempt');
  return { ...result, source_run_id, source_attempt, channels: selection(input.channels, PUBLISH_CHANNELS), confirmation: result.version };
}
export function expectedArtifacts(request) {
  return request.targets.flatMap(target => target === 'docker' ? ['release-docker-amd64', 'release-docker-arm64'] : target === 'macos' ? ['release-macos', 'release-macos-proof'] : [`release-${target}`]);
}
export function assertBuildRun(run, id, attempt) {
  if (run.id !== Number(id) || run.run_attempt !== Number(attempt) || run.repository?.full_name !== CLOUD_REPO ||
      run.path !== `.github/workflows/${BUILD_WORKFLOW}` || run.event !== 'workflow_dispatch' ||
      run.status !== 'completed' || run.conclusion !== 'success' || !/^[a-f0-9]{40}$/.test(run.head_sha)) throw Error('构建来源、状态或 attempt 不匹配');
}

export function compareVersions(left, right) {
  const a = version(left).split('.').map(BigInt), b = version(right).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return 1; if (a[i] < b[i]) return -1; }
  return 0;
}
