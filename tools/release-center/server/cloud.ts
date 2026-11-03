import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILD_WORKFLOW, PUBLISH_WORKFLOW, branch, normalizeBuild, normalizePublish, assertBuildRun, expectedArtifacts } from "../../../scripts/lib/release-cloud-contract.mjs";
import type { BuildRequest, PublishRequest } from "../../../scripts/lib/release-cloud-contract.mjs";
import type { CloudPlan, CloudRequest } from "../shared.ts";
import { Store } from "./store.ts";
import { GitHub } from "./github.ts";
import { AppError, redact } from "./errors.ts";

function validate<T>(action: () => T): T {
  try { return action(); } catch (error) { throw new AppError(400, (error as Error).message); }
}

export class Cloud {
  private busy = false;
  constructor(readonly store: Store, readonly github: GitHub, private root: string, readonly publishEnabled = false) {}
  records(): CloudRequest[] {
    return this.store.db.prepare("SELECT data FROM cloud_requests ORDER BY rowid DESC LIMIT 100").all().map(row => JSON.parse(String(row.data)));
  }
  get(id: string): CloudRequest {
    const row = this.store.db.prepare("SELECT data FROM cloud_requests WHERE id=?").get(id);
    if (!row) throw new AppError(404, "远端任务不存在");
    return JSON.parse(String(row.data));
  }
  private save(value: CloudRequest) {
    value.updatedAt = new Date().toISOString();
    this.store.db.prepare("UPDATE cloud_requests SET active=?,data=? WHERE id=?").run(["dispatching", "unknown", "running"].includes(value.state) ? 1 : 0, JSON.stringify(value), value.id);
  }
  async plan(raw: any): Promise<CloudPlan> {
    const ref = validate(() => branch(raw.branch));
    const sha = await this.github.resolve(ref);
    const input = validate(() => normalizeBuild({ ...raw, commit_sha: sha, request_id: randomUUID() }));
    input.notes = redact(input.notes, [this.github.token]);
    const paths = [`.github/workflows/${BUILD_WORKFLOW}`, ".github/workflows/release-center-candidate.yml", ".github/workflows/ios-release.yml", ".github/workflows/microsoft-store-appx.yml", "scripts/release-cloud-ci.mjs", "scripts/lib/release-cloud-contract.mjs"];
    for (const path of paths) {
      if (await this.github.content(path, sha) !== await readFile(join(this.root, path), "utf8")) throw new AppError(409, "远端构建代码与本机审阅版本不同；请先提交、推送并登记工作流");
    }
    for (const path of ["package.json", "package-lock.json", "backend/package.json", "backend/package-lock.json"]) {
      const value = JSON.parse(await this.github.content(path, sha));
      if (value.version !== input.version || (path.endsWith("lock.json") && value.packages?.[""]?.version !== input.version)) throw new AppError(409, `远端版本不一致：${path}；请先提交版本修改`);
    }
    const android = await this.github.content("frontend/android/app/build.gradle", sha);
    if (android.match(/versionName\s+["']([^"']+)/)?.[1] !== input.version) throw new AppError(409, "远端 Android 版本不一致");
    await this.github.request(`actions/workflows/${BUILD_WORKFLOW}`);
    const plan: CloudPlan = { id: input.request_id, notes: input.notes, branch: ref, sha, version: input.version, targets: input.targets, createdAt: new Date().toISOString() };
    this.store.db.prepare("INSERT INTO cloud_plans VALUES(?,?)").run(plan.id, JSON.stringify(plan));
    return plan;
  }
  async build(raw: any) {
    if (raw.confirm !== true) throw new AppError(400, "请确认在 GitHub Actions 构建所选目标");
    const existing = this.store.db.prepare("SELECT data FROM cloud_requests WHERE id=?").get(String(raw.planId));
    if (existing) return this.get(String(raw.planId));
    const row = this.store.db.prepare("SELECT data FROM cloud_plans WHERE id=?").get(String(raw.planId));
    if (!row) throw new AppError(404, "请先检查远端版本");
    const plan: CloudPlan = JSON.parse(String(row.data));
    if (Date.now() - Date.parse(plan.createdAt) > 30 * 60_000 || await this.github.resolve(plan.branch) !== plan.sha) throw new AppError(409, "分支已变化或计划过期，请重新检查");
    const input = normalizeBuild({ version: plan.version, request_id: plan.id, commit_sha: plan.sha, targets: plan.targets, notes: plan.notes });
    return this.submit("build", plan.branch, plan.sha, input);
  }
  async publish(raw: any) {
    if (!this.publishEnabled) throw new AppError(403, "正式发布触发默认关闭；需配置 NOWEN_RELEASE_CLOUD_PUBLISH=1");
    const input = validate(() => normalizePublish(raw));
    const existing = this.store.db.prepare("SELECT data FROM cloud_requests WHERE id=?").get(input.request_id);
    if (existing) {
      const saved = this.get(input.request_id);
      if (saved.branch !== raw.branch || JSON.stringify(saved.inputs) !== JSON.stringify(input)) throw new AppError(409, "请求 UUID 已用于其他参数");
      return saved;
    }
    const ref = validate(() => branch(raw.branch)), sha = await this.github.resolve(ref);
    for (const path of [`.github/workflows/${PUBLISH_WORKFLOW}`, "scripts/release-cloud-publish.mjs", "scripts/release-cloud-ci.mjs", "scripts/lib/release-cloud-contract.mjs"]) {
      if (await this.github.content(path, sha) !== await readFile(join(this.root, path), "utf8")) throw new AppError(409, "远端发布代码与本机审阅版本不同");
    }
    assertBuildRun(await this.github.run(input.source_run_id), input.source_run_id, input.source_attempt);
    return this.submit("publish", ref, sha, input);
  }
  private async submit(kind: "build" | "publish", ref: string, sha: string, input: BuildRequest | PublishRequest) {
    if (!this.github.token) throw new AppError(403, "需要服务端 GitHub Token（Actions 写权限）");
    const workflow = kind === "build" ? BUILD_WORKFLOW : PUBLISH_WORKFLOW;
    const value: CloudRequest = { id: input.request_id, kind, branch: ref, workflow, workflowSha: sha, inputs: input, state: "dispatching", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), jobs: [], artifacts: [] };
    const fingerprint = createHash("sha256").update(JSON.stringify(value.inputs)).digest("hex");
    const created = this.store.transaction(() => {
      const previous = this.store.db.prepare("SELECT data,fingerprint FROM cloud_requests WHERE id=?").get(value.id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new AppError(409, "请求 UUID 已用于其他参数");
        return false;
      }
      if (this.store.tasks(true).length || this.store.db.prepare("SELECT id FROM cloud_requests WHERE active=1").get()) throw new AppError(409, "已有活动任务，请等待完成");
      this.store.db.prepare("INSERT INTO cloud_requests VALUES(?,?,?,?)").run(value.id, fingerprint, 1, JSON.stringify(value));
      this.store.audit(value.id, "cloud.dispatch.intent", `${kind} ${ref} SHA=${sha}`);
      return true;
    });
    if (!created) return this.get(value.id);
    try {
      const inputs = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value)]));
      await this.github.request(`actions/workflows/${workflow}/dispatches`, "POST", { ref, inputs });
    } catch (error) {
      if (error instanceof AppError && [400, 401, 403, 404, 422, 429].includes(error.status)) {
        value.state = "failed"; value.error = `GitHub 已拒绝触发：${redact(error.message, [this.github.token])}`; this.save(value); return value;
      }
      value.error = `触发结果待核实：${redact((error as Error).message, [this.github.token])}；不会自动重发`;
    }
    value.state = "unknown";
    this.save(value);
    return value;
  }
  async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const value of this.records().filter(r => ["dispatching", "unknown", "running"].includes(r.state))) {
        try {
          if (!value.runId) {
            const since = encodeURIComponent(`>=${value.createdAt}`);
            const runs = await this.github.list(`actions/workflows/${value.workflow}/runs?event=workflow_dispatch&created=${since}`, "workflow_runs");
            const found = runs.filter(run => run.display_title === `Release ${value.kind} ${value.id}`);
            if (found.length > 1) throw Error("发现重复远端任务，请人工核查");
            if (!found.length) continue;
            if (found[0].head_sha !== value.workflowSha || found[0].path !== `.github/workflows/${value.workflow}`) throw Error("远端工作流来源已变化，请人工核查");
            value.runId = found[0].id;
            value.url = `https://github.com/cropflre/nowen-note/actions/runs/${value.runId}`;
          }
          const remote = await this.github.run(value.runId!);
          if (remote.head_sha !== value.workflowSha || remote.path !== `.github/workflows/${value.workflow}`) throw Error("远端来源不匹配");
          value.runAttempt = remote.run_attempt;
          value.jobs = await this.github.jobs(value.runId!);
          value.artifacts = await this.github.artifacts(value.runId!);
          if (remote.status === "completed" && remote.conclusion === "success" && value.kind === "build") {
            const expected = [...expectedArtifacts(value.inputs as BuildRequest), "release-manifest"];
            if (expected.some(name => value.artifacts.filter(a => a.name === name && !a.expired && /^sha256:[a-f0-9]{64}$/.test(a.digest || "")).length !== 1)) {
              value.state = "failed"; value.error = "构建缺少必要产物或产物已过期；不能发布"; this.save(value); continue;
            }
          }
          value.state = remote.status !== "completed" ? "running" : remote.conclusion === "success" ? "succeeded" : "failed";
          value.error = remote.status === "completed" && remote.conclusion !== "success" ? `GitHub 结果：${remote.conclusion}；请查看各 Job，部分渠道可能已完成` : undefined;
          this.save(value);
        } catch (error) { value.error = redact((error as Error).message, [this.github.token]); this.save(value); }
      }
    } finally { this.busy = false; }
  }
  view() { return { enabled: Boolean(this.github.token), publishEnabled: this.publishEnabled, requests: this.records() }; }
}
