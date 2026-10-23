import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORMS, type Job, type Plan, type PublicationView, type ReleaseCandidate, type Task, type VerifiedFile } from "../shared.ts";
import { Store } from "./store.ts";
import { GitHub } from "./github.ts";
import { AppError, redactValue } from "./errors.ts";
import { channelVersion } from "./channels.ts";
import { versionChecks } from "./planner.ts";
import { ARCHIVE_LIMITS, verifyArchive } from "./verification.ts";

const names = { windows: "nowen-note-win-direct", macos: "nowen-note-mac", linux: "nowen-note-linux" };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fields = (raw: any, allowed: string[]) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !allowed.includes(key)))
    throw new AppError(400, "无效的正式候选请求字段");
};
function key(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{16,80}$/.test(value)) throw new AppError(400, "无效幂等键");
  return value;
}
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const files = (candidate: ReleaseCandidate) => candidate.verifications.flatMap((v) => v.files).sort((a, b) => a.name.localeCompare(b.name));
const marker = (candidate: ReleaseCandidate) => `<!-- nowen-release-center:${candidate.id}:${candidate.digest} -->`;
const releaseBody = (candidate: ReleaseCandidate) => `${candidate.notes}\n\n### 桌面端支持\n\n- Windows x64 Full / Lite（GitHub 直接下载，安装包未提供代码签名）\n- macOS Intel x64 / Apple Silicon arm64\n- Linux x64\n\n${marker(candidate)}`;

export class Publication {
  private controllers = new Map<string, AbortController>();
  private stopping = false;
  constructor(readonly store: Store, readonly github: GitHub,
    readonly writer = new GitHub(),
    readonly config: { drafts?: boolean; publish?: boolean; maintainerId?: number } = {}) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS release_candidates(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS release_reservations(version TEXT PRIMARY KEY, candidateId TEXT UNIQUE NOT NULL);`);
  }
  private save(candidate: ReleaseCandidate, event: string) {
    const safe = JSON.stringify(redactValue(candidate, [this.github.token, this.writer.token]));
    this.store.transaction(() => {
      this.store.db.prepare("INSERT INTO release_candidates VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(candidate.id, safe);
      this.store.audit(candidate.id, event, JSON.stringify({ id: candidate.id, tag: candidate.tag, sha: candidate.sha, state: candidate.state,
        digest: candidate.digest, draftId: candidate.draftId, approval: candidate.approval, error: candidate.error }));
    });
  }
  candidate(id: string): ReleaseCandidate {
    const row = this.store.db.prepare("SELECT data FROM release_candidates WHERE id=?").get(id);
    if (!row) throw new AppError(404, "正式候选不存在");
    return JSON.parse(String(row.data));
  }
  view(): PublicationView {
    return { candidates: this.store.db.prepare("SELECT data FROM release_candidates ORDER BY rowid DESC LIMIT 100").all().map((r) => JSON.parse(String(r.data))),
      draftsEnabled: !!this.config.drafts && !!this.writer.token && positive(this.config.maintainerId),
      publishEnabled: !!this.config.publish && !!this.config.drafts && !!this.writer.token && positive(this.config.maintainerId), buildDispatchEnabled: false };
  }
  private plan(candidate: ReleaseCandidate): Plan {
    return { id: candidate.id, branch: candidate.tag, sha: candidate.sha, version: candidate.version, channel: "stable", platforms: [...PLATFORMS], notes: candidate.notes,
      createdAt: new Date().toISOString(), checks: [], ready: true, debugReady: false, workflowRef: candidate.tag, workflowSha: candidate.sha,
      effects: ["导入已存在 Tag 的正式三平台构建；不推 Tag、不 dispatch，也不上传 TestFlight、Docker 或商店", "Windows Full 与 Lite、macOS 双架构、Linux 全部校验后才能准备 Draft；审批与发布分开确认"] };
  }
  private task(candidate: ReleaseCandidate, operation: "verify" | "draft" | "publish", requestKey: string, fingerprint: string, jobs: Job[] = [], reserveVersion = false) {
    const at = new Date().toISOString();
    return this.store.create({ id: randomUUID(), key: requestKey, mode: "publication", plan: this.plan(candidate), state: "queued", createdAt: at, updatedAt: at,
      deadline: Date.now() + 90 * 60_000, runId: candidate.runId, jobs, artifacts: candidate.artifacts, publication: { candidateId: candidate.id, operation } }, fingerprint, reserveVersion ? () => {
        const reserved = this.store.db.prepare("SELECT candidateId FROM release_reservations WHERE version=?").get(candidate.version);
        if (reserved && reserved.candidateId !== candidate.id) throw new AppError(409, "版本已由另一个候选占用，禁止覆盖");
        this.store.db.prepare("INSERT OR IGNORE INTO release_reservations VALUES(?,?)").run(candidate.version, candidate.id);
      } : undefined);
  }
  private async checkSource(candidate: ReleaseCandidate) {
    const [run, tagSha, checks] = await Promise.all([this.github.run(candidate.runId), this.github.tagCommit(candidate.tag),
      this.github.list(`commits/${candidate.sha}/check-runs`, "check_runs")]);
    if (run.id !== candidate.runId || run.path?.split("@")[0] !== ".github/workflows/release.yml" || run.event !== "push" ||
      run.head_branch !== candidate.tag || run.head_sha !== candidate.sha || tagSha !== candidate.sha ||
      run.status !== "completed" || run.conclusion !== "success" || run.run_attempt !== candidate.runAttempt)
      throw new AppError(409, "只接收既有 release.yml 的成功 Tag 构建；Run、Tag SHA 或重跑轮次已变化");
    // RC1 runs on every release tag; the console workflow is path-filtered and may be absent.
    if (!checks.some((c) => c.name === "rc1-security" && c.status === "completed" && c.conclusion === "success"))
      throw new AppError(409, "正式候选缺少已通过的关键门禁：rc1-security");
    if (checks.some((c) => c.status !== "completed" || !["success", "skipped", "neutral"].includes(c.conclusion)))
      throw new AppError(409, "固定 SHA 还有未完成或失败的检查");
  }
  async importRun(raw: any): Promise<Task> {
    fields(raw, ["version", "runId", "notes", "key"]);
    const version = channelVersion(raw.version);
    if (!positive(raw.runId) || typeof raw.notes !== "string" || !raw.notes.trim() || raw.notes.length > 20_000)
      throw new AppError(400, "请提供正式 Run ID 和发布说明");
    const requestKey = key(raw.key);
    const hash = `publication-import:${digest({ version, runId: raw.runId, notes: raw.notes })}`;
    const previous = this.store.byKey(requestKey, hash);
    if (previous) return previous;
    const run = await this.github.run(raw.runId);
    if (!positive(run.run_attempt) || !/^[a-f0-9]{40}$/.test(run.head_sha || "")) throw new AppError(409, "无效的正式构建来源");
    const candidate: ReleaseCandidate = { id: randomUUID(), version, tag: `v${version}`, sha: run.head_sha, runId: raw.runId, runAttempt: run.run_attempt,
      notes: raw.notes, createdAt: new Date().toISOString(), state: "verifying", artifacts: [], verifications: [] };
    await this.checkSource(candidate);
    for (const path of [".github/workflows/release.yml", "scripts/lib/update-metadata-validator.cjs", "scripts/lib/release-platform-assets.cjs"]) {
      const [remote, installed] = await Promise.all([this.github.content(path, candidate.sha), readFile(new URL(`../../../${path}`, import.meta.url), "utf8")]);
      if (remote.replace(/\r\n/g, "\n") !== installed.replace(/\r\n/g, "\n")) throw new AppError(409, `正式构建协议不同，需要先审阅并更新服务端：${path}`);
    }
    const paths = ["package.json", "package-lock.json", "backend/package.json", "backend/package-lock.json", "frontend/android/app/build.gradle"];
    const contents = await Promise.all(paths.map(async (path) => [path, await this.github.content(path, candidate.sha)] as const));
    if (versionChecks(Object.fromEntries(contents), version).some((check) => check.status !== "pass"))
      throw new AppError(409, "正式源码的版本文件不一致");
    const [artifacts, jobs] = await Promise.all([this.github.artifacts(candidate.runId), this.github.jobs(candidate.runId)]);
    for (const platform of PLATFORMS) {
      const found = artifacts.filter((a) => a.name === names[platform] && !a.expired);
      if (found.length !== 1) throw new AppError(409, `正式构建缺少唯一 ${platform} artifact；不允许部分平台代替完整发布`);
      candidate.artifacts.push(found[0]);
    }
    // No await between the final idempotency check, task reservation and candidate persistence.
    const raced = this.store.byKey(requestKey, hash);
    if (raced) return raced;
    this.save(candidate, "publication.imported");
    try { return this.task(candidate, "verify", requestKey, hash, jobs); }
    catch (error) { candidate.state = "failed"; candidate.error = "未能建立互斥校验任务"; this.save(candidate, "publication.import_rejected"); throw error; }
  }
  private verified(candidate: ReleaseCandidate) {
    if (!candidate.digest || candidate.verifications.length !== 3 || !PLATFORMS.every((p) => candidate.verifications.some((v) => v.platform === p)) ||
      new Set(files(candidate).map((f) => f.name)).size !== files(candidate).length)
      throw new AppError(409, "所有正式平台必须先下载复核，不能使用调试验收代替");
  }
  async actor() {
    if (!this.view().draftsEnabled) throw new AppError(403, "正式写操作默认关闭；需要独立发布凭据、服务端维护者 ID 和 Draft 开关");
    const actor = await this.writer.authenticatedUser();
    if (actor.type !== "User" || actor.id !== this.config.maintainerId || !/^[A-Za-z0-9-]{1,39}$/.test(actor.login))
      throw new AppError(403, "发布凭据身份不符合服务端维护者配置");
    const permission = await this.writer.request(`collaborators/${encodeURIComponent(actor.login)}/permission`);
    if (!["admin", "maintain", "write"].includes(permission.permission)) throw new AppError(403, "发布维护者没有仓库写权限");
    return actor;
  }
  async submit(id: string, operation: "draft" | "publish", raw: any): Promise<Task> {
    fields(raw, ["key", "digest", "tag", operation === "draft" ? "confirmDraft" : "confirmPublish"]);
    const requestKey = key(raw.key), candidate = this.candidate(id);
    const fingerprint = `publication-${operation}:${digest({ candidateId: candidate.id, tag: raw.tag, digest: raw.digest,
      confirm: raw[operation === "draft" ? "confirmDraft" : "confirmPublish"] })}`;
    const previous = this.store.byKey(requestKey, fingerprint);
    if (previous) return previous;
    this.verified(candidate);
    if (raw.digest !== candidate.digest || raw.tag !== candidate.tag || raw[operation === "draft" ? "confirmDraft" : "confirmPublish"] !== true)
      throw new AppError(400, "请确认固定版本和产物证据；Draft 和正式发布分别确认");
    await this.actor();
    if (operation === "publish" && (!this.view().publishEnabled || candidate.state !== "approved" || !candidate.approval))
      throw new AppError(403, "正式发布未启用或尚未审批");
    const current = this.candidate(id);
    if (current.state === "published" || (operation === "publish" && current.state !== "approved")) throw new AppError(409, "候选状态已变化或已发布，禁止覆盖");
    // Reserve the version only if the task is successfully inserted. Both writes commit atomically.
    return this.task(candidate, operation, requestKey, fingerprint, [], true);
  }
  private assetsMatch(candidate: ReleaseCandidate, assets: any[]) {
    const expected = files(candidate);
    if (!Array.isArray(assets) || assets.length !== expected.length || new Set(assets.map((a) => a.name)).size !== assets.length ||
      expected.some((file) => !assets.some((a) => a.name === file.name && a.state === "uploaded" && positive(a.id) && a.size === file.size && a.digest === `sha256:${file.sha256}`)))
      throw new AppError(409, "Draft 产物缺失、额外文件、大小或远端 SHA-256 与证据不符");
  }
  private async release(candidate: ReleaseCandidate, complete = true, published = false): Promise<any> {
    if (!positive(candidate.draftId)) throw new AppError(409, "尚未绑定 Draft");
    const release = await this.writer.request(`releases/${candidate.draftId}`);
    if (release.id !== candidate.draftId || release.tag_name !== candidate.tag || release.body !== releaseBody(candidate) ||
      release.author?.id !== candidate.authorId || release.prerelease !== false || release.draft !== !published ||
      (!published && (release.immutable || release.published_at))) throw new AppError(409, "Release 身份、说明或状态已改变；禁止接管/覆盖");
    const assets = await this.writer.list(`releases/${candidate.draftId}/assets`);
    if (complete) this.assetsMatch(candidate, assets);
    return { ...release, assets };
  }
  async approve(id: string, raw: any) {
    fields(raw, ["tag", "digest", "confirmApproval"]);
    const candidate = this.candidate(id);
    this.verified(candidate);
    if (this.store.tasks(true).length || !["draft", "approved"].includes(candidate.state) || raw.tag !== candidate.tag || raw.digest !== candidate.digest || raw.confirmApproval !== true)
      throw new AppError(409, "Draft 尚未完成、存在活动任务或没有明确确认审批");
    const actor = await this.actor();
    await this.checkSource(candidate);
    const release = await this.release(candidate);
    const evidence = digest({ candidate: candidate.digest, releaseId: release.id, body: release.body,
      assets: release.assets.map((a: any) => ({ id: a.id, name: a.name, size: a.size, digest: a.digest })).sort((a: any, b: any) => a.name.localeCompare(b.name)) });
    // An operation may have been submitted while the read-only API calls were in flight.
    if (this.store.tasks(true).length || !["draft", "approved"].includes(this.candidate(id).state)) throw new AppError(409, "候选状态变化或已有活动任务，审批未保存");
    if (candidate.approval?.digest === evidence && candidate.approval.actorId === actor.id &&
      Date.now() - Date.parse(candidate.approval.at) >= 0 && Date.now() - Date.parse(candidate.approval.at) < 30 * 60_000)
      return candidate;
    candidate.approval = { at: new Date().toISOString(), actorId: actor.id, login: actor.login, digest: evidence };
    candidate.state = "approved";
    this.save(candidate, "publication.approved");
    return candidate;
  }
  cancel(id: string) { this.controllers.get(id)?.abort(new Error("用户取消正式候选操作")); }
  stop() { this.stopping = true; for (const c of this.controllers.values()) c.abort(new Error("服务停止")); }
  private intent(task: Task, kind: "draft" | "asset" | "publish", name?: string) {
    task.publication!.intent = { kind, ...(name ? { name } : {}) };
    task.dispatchedAt ||= new Date().toISOString();
    task.state = "reconciling";
    this.store.save(task, "publication.write_intent", JSON.stringify(task.publication));
  }
  private acknowledged(task: Task) {
    const current = this.store.task(task.id);
    current.publication!.intent = undefined;
    current.publication!.retryAt = undefined;
    current.state = "running";
    this.store.save(current, "publication.write_acknowledged", JSON.stringify(task.publication));
  }
  private async remoteWrite<T>(taskId: string, send: () => Promise<T>): Promise<T> {
    try { return await send(); }
    catch (error) {
      // Only a rejection of the write itself resolves its intent. A failed reconciliation GET does not.
      if (error instanceof AppError && [400, 401, 403, 404, 422, 429].includes(error.status)) {
        const current = this.store.task(taskId);
        current.publication!.intent = undefined;
        this.store.save(current, "publication.write_rejected", error.message);
      }
      throw error;
    }
  }
  private async archives(candidate: ReleaseCandidate, task: Task, signal: AbortSignal, upload = false) {
    await this.checkSource(candidate);
    const results = [];
    for (const platform of PLATFORMS) {
      signal.throwIfAborted();
      const artifact = candidate.artifacts.find((a) => a.name === names[platform])!;
      const meta = await this.github.artifactMeta(artifact.id);
      if (meta.id !== artifact.id || meta.name !== artifact.name || meta.expired || meta.workflow_run?.id !== candidate.runId ||
        meta.workflow_run?.head_sha !== candidate.sha || !positive(meta.size_in_bytes) || meta.size_in_bytes > ARCHIVE_LIMITS.archive ||
        !/^sha256:[a-f0-9]{64}$/.test(meta.digest || "") || (artifact.digest && meta.digest !== artifact.digest))
        throw new AppError(409, "正式 artifact 来源、有效期、大小或摘要不符");
      const directory = await mkdtemp(join(tmpdir(), "nowen-rc-formal-"));
      try {
        const path = join(directory, "artifact.zip");
        await this.github.downloadArtifact(artifact.id, path, signal, meta.size_in_bytes);
        if ((await stat(path)).size !== meta.size_in_bytes) throw new AppError(422, "正式 artifact archive 大小不符");
        const result = await verifyArchive(path, { taskId: candidate.id, sha: candidate.sha, version: candidate.version, platform, purpose: "formal-import" }, meta.digest, signal,
          ARCHIVE_LIMITS, upload ? async (unpacked, content) => {
            const expected = candidate.verifications.find((v) => v.platform === platform);
            if (!expected || JSON.stringify(expected.files) !== JSON.stringify(content.files) || expected.archiveDigest !== meta.digest)
              throw new AppError(409, "正式产物已变化，旧证据与审批失效");
            for (const file of content.files) {
              signal.throwIfAborted();
              const remote = await this.release(candidate, false);
              const asset = remote.assets.find((a: any) => a.name === file.name);
              if (asset) { this.assetMatch(file, asset); continue; }
              const current = this.store.task(task.id);
              if (current.cancelReason) throw new Error("操作已取消");
              this.intent(current, "asset", file.name);
              const added = await this.remoteWrite(task.id, () => this.writer.uploadReleaseAsset(candidate.draftId!, file.name, join(unpacked, file.name), signal));
              this.assetMatch(file, added);
              this.acknowledged(current);
            }
          } : undefined);
        results.push({ artifactId: artifact.id, platform, archiveDigest: meta.digest, verifiedAt: new Date().toISOString(), files: result.files, metadata: result.updaterVerification });
        if (!upload) {
          candidate.verifications = [...results];
          this.save(candidate, "publication.platform_verified");
        }
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
    return results;
  }
  private assetMatch(file: VerifiedFile, asset: any) {
    if (!positive(asset?.id) || asset.name !== file.name || asset.state !== "uploaded" || asset.size !== file.size || asset.digest !== `sha256:${file.sha256}`)
      throw new AppError(409, "远端文件摘要不符或同名资产已存在；禁止删除、覆盖或重新上传");
  }
  private async reconcile(task: Task, candidate: ReleaseCandidate): Promise<boolean> {
    const intent = task.publication!.intent;
    if (!intent) return true;
    if (intent.kind === "draft") {
      const releases = (await this.writer.list("releases")).filter((r) => r.tag_name === candidate.tag);
      if (!releases.length) return false;
      if (releases.length !== 1) throw new AppError(409, "同版本多个 Release，需要人工处理");
      candidate.draftId = releases[0].id;
      await this.release(candidate, false);
      this.save(candidate, "publication.draft_recovered");
    } else if (intent.kind === "asset") {
      const release = await this.release(candidate, false);
      const asset = release.assets.find((a: any) => a.name === intent.name);
      if (!asset) return false;
      const expected = files(candidate).find((f) => f.name === intent.name);
      if (!expected) throw new AppError(409, "未知产物写入意图");
      this.assetMatch(expected, asset);
    } else {
      const remote = await this.writer.request(`releases/${candidate.draftId}`);
      if (remote.draft) return false;
      await this.checkSource(candidate);
      await this.release(candidate, true, true);
      candidate.state = "published";
      this.save(candidate, "publication.published_recovered");
    }
    this.acknowledged(task);
    return true;
  }
  async advance(id: string) {
    let task = this.store.task(id);
    if (Date.now() < (task.publication?.retryAt || 0)) return;
    const candidate = this.candidate(task.publication!.candidateId);
    const operation = task.publication!.operation;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const timer = setTimeout(() => {
      const current = this.store.task(id); current.cancelReason = "timed_out";
      this.store.save(current, "publication.timeout", "正式操作到达截止时间；不明写操作保持互斥并只读对账");
      controller.abort(new Error("正式操作超时"));
    }, Math.max(1, task.deadline - Date.now()));
    try {
      if (!await this.reconcile(task, candidate)) {
        task = this.store.task(id);
        const message = "远端写操作结果不明；仅对账，绝不自动重发。请人工核查 GitHub，禁止删除数据库解锁。";
        if (task.state !== "reconciling" || task.error !== message) {
          task.state = "reconciling"; task.error = message;
          this.store.save(task, "publication.uncertain", message);
        }
        return;
      }
      task = this.store.task(id);
      if (operation === "publish" && candidate.state === "published") {
        task.state = "succeeded"; task.error = undefined;
        this.store.save(task, "publication.completed", "远端已确认正式发布；取消不能撤销已完成发布");
        return;
      }
      if (task.cancelReason || Date.now() >= task.deadline) {
        task.state = task.cancelReason || "timed_out";
        candidate.state = operation === "verify" ? "failed" : "blocked";
        candidate.error = task.state === "cancelled" ? "操作已取消；已有远端内容保留" : "操作超时；已有远端内容保留";
        this.save(candidate, "publication.stopped");
        this.store.save(task, "publication.stopped", "已停止；已创建的 Draft 与文件保留，不执行删除回滚");
        return;
      }
      task.state = "running";
      this.store.save(task, "publication.started", `${operation} ${candidate.tag} ${candidate.sha}`);
      if (operation === "verify") {
        candidate.verifications = []; candidate.digest = undefined; candidate.state = "verifying"; candidate.approval = undefined;
        this.save(candidate, "publication.verification_started");
        candidate.verifications = await this.archives(candidate, task, controller.signal);
        await this.checkSource(candidate);
        candidate.digest = digest({ tag: candidate.tag, sha: candidate.sha, runId: candidate.runId, runAttempt: candidate.runAttempt, notes: candidate.notes,
          platforms: candidate.verifications.map(({ platform, archiveDigest, artifactId, files, metadata }) => ({ platform, archiveDigest, artifactId, files, metadata })) });
        this.verified(candidate);
        candidate.state = "verified";
      } else {
        this.verified(candidate);
        const actor = await this.actor();
        await this.checkSource(candidate);
        if (operation === "draft") {
          candidate.state = "drafting"; candidate.approval = undefined; candidate.error = undefined;
          this.save(candidate, "publication.draft_started");
          if (!candidate.draftId) {
            const releases = (await this.writer.list("releases")).filter((r) => r.tag_name === candidate.tag);
            if (releases.length) throw new AppError(409, "同版本 Draft 或已发布 Release 已存在，禁止接管/覆盖");
            candidate.authorId = actor.id;
            this.save(candidate, "publication.draft_prepared");
            this.intent(this.store.task(id), "draft");
            const created = await this.remoteWrite(id, () => this.writer.request("releases", "POST", { tag_name: candidate.tag, target_commitish: candidate.sha, name: candidate.tag,
              body: releaseBody(candidate), draft: true, prerelease: false, generate_release_notes: false, make_latest: "false" }));
            if (!positive(created.id)) throw new AppError(502, "Draft 创建返回无效身份");
            candidate.draftId = created.id;
            this.save(candidate, "publication.draft_created");
            await this.release(candidate, false);
            this.acknowledged(this.store.task(id));
          }
          await this.archives(candidate, task, controller.signal, true);
          await this.release(candidate);
          candidate.state = "draft";
        } else {
          if (candidate.state !== "published") {
            const approvalAge = candidate.approval ? Date.now() - Date.parse(candidate.approval.at) : NaN;
            if (!this.view().publishEnabled || candidate.state !== "approved" || !candidate.approval ||
              candidate.approval.actorId !== actor.id || !Number.isFinite(approvalAge) || approvalAge < 0 || approvalAge > 30 * 60_000)
              throw new AppError(403, "正式发布未启用或审批过期，需要重新明确审批");
            const release = await this.release(candidate);
            const evidence = digest({ candidate: candidate.digest, releaseId: release.id, body: release.body,
              assets: release.assets.map((a: any) => ({ id: a.id, name: a.name, size: a.size, digest: a.digest })).sort((a: any, b: any) => a.name.localeCompare(b.name)) });
            if (candidate.approval.digest !== evidence) throw new AppError(409, "远端资产已变更，审批失效");
            try {
              const latest = await this.writer.request("releases/latest");
              if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(latest.tag_name)) throw new AppError(409, "最新正式版本无法安全比较");
              const a = candidate.version.split(".").map(BigInt), b = latest.tag_name.slice(1).split(".").map(BigInt);
              const difference = a.findIndex((n, i) => n !== b[i]);
              if (difference < 0 || a[difference] < b[difference]) throw new AppError(409, "禁止将最新版本回退或覆盖为相同版本");
            } catch (error) { if (!(error instanceof AppError && error.status === 404)) throw error; }
            controller.signal.throwIfAborted();
            if (this.store.task(id).cancelReason) throw new Error("发布已取消");
            this.intent(this.store.task(id), "publish");
            candidate.state = "publishing";
            this.save(candidate, "publication.publish_started");
            await this.remoteWrite(id, () => this.writer.request(`releases/${candidate.draftId}`, "PATCH", { draft: false, make_latest: "true" }));
            await this.release(candidate, true, true);
            this.acknowledged(this.store.task(id));
            candidate.state = "published";
          }
        }
      }
      if (this.stopping) return;
      candidate.error = undefined;
      this.save(candidate, `publication.${candidate.state}`);
      task = this.store.task(id);
      task.state = candidate.state === "published" ? "succeeded" : task.cancelReason || "succeeded"; task.error = undefined; task.verifications = candidate.verifications;
      this.store.save(task, "publication.completed", `${operation} ${candidate.state}; source=${candidate.sha}`);
    } catch (error) {
      if (this.stopping) { this.store.audit(id, "publication.interrupted", "重启后恢复只读校验或对账；不重复写入"); return; }
      task = this.store.task(id);
      task.state = task.publication!.intent ? "reconciling" : task.cancelReason || "failed";
      if (error instanceof AppError && error.status === 429)
        task.publication!.retryAt = Date.now() + Math.max(60, Math.min(3600, Number(error.retryAfter) || 60)) * 1000;
      else if (task.publication!.intent) task.publication!.retryAt = Date.now() + 30_000;
      task.error = error instanceof Error ? error.message : "正式操作失败";
      candidate.error = task.error; candidate.state = operation === "verify" ? "failed" : "blocked"; candidate.approval = undefined;
      this.save(candidate, "publication.blocked");
      this.store.save(task, "publication.error", task.error);
    } finally { clearTimeout(timer); this.controllers.delete(id); }
  }
}
