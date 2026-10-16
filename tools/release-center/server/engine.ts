import { createHash, randomUUID } from "node:crypto";
import type { Task } from "../shared.ts";
import { Store } from "./store.ts";
import { Planner } from "./planner.ts";
import { AppError } from "./errors.ts";
import { verifyArtifacts } from "./verification.ts";
import { Publication } from "./publication.ts";

const active = (task: Task) =>
  ["queued", "running", "reconciling", "cancelling"].includes(task.state);

export class Engine {
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private retryAt = 0;
  private stopping = false;
  private verificationControllers = new Map<string, AbortController>();
  constructor(
    readonly store: Store,
    readonly planner: Planner,
    private now = () => Date.now(),
    private timeoutMs = 4 * 60 * 60 * 1000,
    readonly publication = new Publication(store, planner.github),
  ) {}
  claim() {
    this.store.db.exec(
      "CREATE TABLE IF NOT EXISTS worker (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL)",
    );
    this.store.transaction(() => {
      const row = this.store.db
        .prepare("SELECT pid FROM worker WHERE id=1")
        .get();
      if (row) {
        let alive = true;
        try {
          process.kill(Number(row.pid), 0);
        } catch (error: any) {
          if (error.code === "ESRCH") alive = false;
        }
        if (alive)
          throw new AppError(409, "同一数据库已有 Release Center 服务运行");
      }
      this.store.db
        .prepare("INSERT OR REPLACE INTO worker VALUES(1,?)")
        .run(process.pid);
    });
  }
  start() {
    this.claim();
    this.store.audit(
      null,
      "service.started",
      "恢复活动任务；已记录派发意图的任务只对账，不重复 dispatch",
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, 5000);
    this.timer.unref();
    void this.tick();
  }
  async stop() {
    this.stopping = true;
    this.publication.stop();
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.verificationControllers.values())
      controller.abort(new Error("服务停止；校验将在重启后恢复"));
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 50));
    this.store.db.prepare("DELETE FROM worker WHERE pid=?").run(process.pid);
  }
  submitVerification(sourceId: string, raw: any): Task {
    if (
      !raw ||
      Object.keys(raw).some((key) => key !== "key") ||
      typeof raw.key !== "string" ||
      !/^[A-Za-z0-9-]{16,80}$/.test(raw.key)
    )
      throw new AppError(400, "无效的产物校验请求");
    const fingerprint = `verify:${sourceId}`;
    const existing = this.store.byKey(raw.key, fingerprint);
    if (existing) return existing;
    const source = this.store.task(sourceId);
    if (
      source.mode !== "debug" ||
      source.state !== "succeeded" ||
      !source.runId ||
      !source.artifacts.length
    )
      throw new AppError(409, "只能下载校验成功调试任务的产物");
    const at = new Date(this.now()).toISOString();
    return this.store.create(
      {
        id: randomUUID(),
        key: raw.key,
        mode: "verify",
        sourceTaskId: source.id,
        plan: source.plan,
        state: "queued",
        createdAt: at,
        updatedAt: at,
        deadline: this.now() + Math.min(this.timeoutMs, 90 * 60_000),
        runId: source.runId,
        jobs: [],
        artifacts: source.artifacts,
        verifications: [],
      },
      fingerprint,
    );
  }
  accept(id: string, raw: any): Task {
    const task = this.store.task(id);
    if (
      task.mode !== "verify" ||
      task.state !== "succeeded" ||
      !task.verifications?.length ||
      task.verifications.length !== task.plan.platforms.length ||
      !task.plan.platforms.every((p) =>
        task.verifications!.some((v) => v.platform === p),
      )
    )
      throw new AppError(409, "所有选定平台必须先完成下载校验");
    if (
      !raw ||
      Object.keys(raw).some(
        (key) => !["version", "sha", "confirmDebugOnly"].includes(key),
      ) ||
      raw.version !== task.plan.version ||
      raw.sha !== task.plan.sha ||
      raw.confirmDebugOnly !== true
    )
      throw new AppError(400, "请明确确认版本、SHA 和仅用于调试验收");
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          source: task.sourceTaskId,
          sha: task.plan.sha,
          workflowSha: task.plan.workflowSha,
          version: task.plan.version,
          results: task.verifications.map(
            ({ platform, artifactId, archiveDigest, files, metadata }) => ({
              platform,
              artifactId,
              archiveDigest,
              files,
              metadata,
            }),
          ),
        }),
      )
      .digest("hex");
    if (task.acceptance) {
      if (task.acceptance.digest !== digest)
        throw new AppError(409, "已有验收记录与当前产物不符，禁止覆盖");
      return task;
    }
    task.acceptance = {
      at: new Date(this.now()).toISOString(),
      digest,
      scope: "debug-only",
      actor: "local-maintainer",
    };
    this.store.save(
      task,
      "artifact.accepted",
      `仅调试验收；v${task.plan.version} SHA=${task.plan.sha} evidence=${digest}；不授权 Draft、Tag 或正式发布`,
    );
    return task;
  }
  submit(raw: any): Task {
    if (
      !raw ||
      Object.keys(raw).some(
        (k) => !["planId", "mode", "key", "confirmDebug"].includes(k),
      ) ||
      !["dry-run", "debug"].includes(raw.mode) ||
      typeof raw.planId !== "string" ||
      typeof raw.key !== "string" ||
      !/^[A-Za-z0-9-]{16,80}$/.test(raw.key)
    )
      throw new AppError(400, "无效任务；仅支持 Dry Run 和调试构建");
    const fingerprint = `${raw.planId}:${raw.mode}`;
    const existing = this.store.byKey(raw.key, fingerprint);
    if (existing) return existing;
    const plan = this.store.plan(raw.planId);
    if (this.now() - Date.parse(plan.createdAt) > 30 * 60_000)
      throw new AppError(409, "计划已过期，请重新预检");
    if (
      raw.mode === "debug" &&
      (!plan.debugReady ||
        raw.confirmDebug !== true ||
        !this.planner.debugEnabled ||
        !this.planner.github.token)
    )
      throw new AppError(403, "调试预检尚未通过，或未确认启动调试构建");
    const at = new Date(this.now()).toISOString();
    return this.store.create(
      {
        id: randomUUID(),
        key: raw.key,
        mode: raw.mode,
        plan,
        state: "queued",
        createdAt: at,
        updatedAt: at,
        deadline:
          this.now() + (raw.mode === "dry-run" ? 120_000 : this.timeoutMs),
        jobs: [],
        artifacts: [],
      },
      fingerprint,
    );
  }
  cancel(id: string): Task {
    const task = this.store.task(id);
    if (!active(task)) return task;
    // Cancellation remains active until the remote workflow acknowledges completion.
    task.cancelReason = "cancelled";
    if (task.mode === "publication") {
      task.state = "cancelling";
      this.publication.cancel(id);
    } else if (task.mode === "verify" && this.verificationControllers.has(id)) {
      task.state = "cancelling";
      this.verificationControllers
        .get(id)!
        .abort(new Error("用户取消产物校验"));
    } else if (!task.dispatchedAt) task.state = "cancelled";
    else task.state = "cancelling";
    this.store.save(
      task,
      "task.cancel_requested",
      task.mode === "publication" ? "用户请求停止正式候选操作；不明写入仅对账，已有远端资产不自动撤销" : task.mode === "verify"
        ? "用户请求取消本地产物校验；等待下载和校验停止"
        : "用户请求取消；已派发任务等待远端确认",
    );
    return task;
  }
  async captureLog(taskId: string, jobId: number) {
    const task = this.store.task(taskId);
    const job = task.jobs.find((j) => j.id === jobId);
    if (!job || job.status !== "completed")
      throw new AppError(
        409,
        "完整日志将在 Job 完成后可用；当前可查看步骤进度",
      );
    const text = await this.planner.github.jobLog(jobId);
    this.store.audit(task.id, `job.log.${jobId}`, text);
  }
  async tick() {
    if (this.busy || this.now() < this.retryAt) return;
    this.busy = true;
    try {
      for (const snapshot of this.store.tasks(true)) {
        try {
          await this.advance(snapshot.id);
        } catch (error: any) {
          const task = this.store.task(snapshot.id);
          if (!active(task)) continue;
          task.error = error.message || "任务处理失败";
          if (!task.dispatchedAt) task.state = "failed";
          else if (task.state !== "cancelling") task.state = "reconciling";
          this.store.save(task, "task.error", task.error!);
          const seconds =
            error instanceof AppError && error.status === 429
              ? Math.max(60, Math.min(3600, Number(error.retryAfter) || 60))
              : 30;
          this.retryAt = this.now() + seconds * 1000;
        }
      }
    } finally {
      this.busy = false;
    }
  }
  private async advance(id: string) {
    let task = this.store.task(id);
    if (!active(task)) return;
    if (task.mode === "publication") {
      await this.publication.advance(id);
      return;
    }
    if (task.mode === "verify") {
      await this.verify(id);
      return;
    }
    if (task.mode !== "dry-run" && task.mode !== "debug")
      throw new AppError(400, "未知任务类型；禁止派发工作流");
    if (this.now() >= task.deadline && !task.cancelReason) {
      task.cancelReason = "timed_out";
      if (!task.dispatchedAt) task.state = "timed_out";
      else task.state = "cancelling";
      this.store.save(
        task,
        "task.timeout",
        "超时；远端任务需要确认停止后才释放互斥",
      );
      if (!active(task)) return;
    }
    if (!task.dispatchedAt) {
      task.state = "running";
      this.store.save(
        task,
        "preflight.started",
        `重新检查固定 SHA ${task.plan.sha}`,
      );
      const { branch, version, channel, platforms, notes } = task.plan;
      const refreshed = await this.planner.create({
        branch,
        version,
        channel,
        platforms,
        notes,
      });
      task = this.store.task(id); // A cancellation during the API request must win.
      if (!active(task)) return;
      if (this.now() >= task.deadline) {
        task.state = "timed_out";
        this.store.save(task, "task.timeout", "预检超时；尚未派发远端构建");
        return;
      }
      if (!refreshed.ready || refreshed.sha !== task.plan.sha) {
        task.state = "failed";
        task.error = "预检未通过或分支 SHA 已变化，请创建新计划";
        this.store.save(
          task,
          "preflight.failed",
          JSON.stringify(refreshed.checks),
        );
        return;
      }
      if (task.mode === "dry-run") {
        task.state = "succeeded";
        this.store.save(
          task,
          "dry_run.completed",
          JSON.stringify({
            sha: task.plan.sha,
            checks: refreshed.checks,
            effects: task.plan.effects,
            scope: "计划检查完成；未执行编译、产物验证或正式发布",
          }),
        );
        return;
      }
      if (
        !refreshed.debugReady ||
        refreshed.workflowSha !== task.plan.workflowSha
      )
        throw new AppError(409, "调试工作流或权限已变化，请重新预检");
      task.dispatchedAt = new Date(this.now()).toISOString();
      task.state = "reconciling";
      this.store.save(
        task,
        "dispatch.intent",
        "持久化派发意图；即使网络中断或服务重启也不自动重发",
      );
      try {
        await this.planner.github.dispatch(task.plan.workflowRef, {
          task_id: task.id,
          commit_sha: task.plan.sha,
          version: task.plan.version,
          windows: String(task.plan.platforms.includes("windows")),
          macos: String(task.plan.platforms.includes("macos")),
          linux: String(task.plan.platforms.includes("linux")),
        });
        this.store.audit(
          id,
          "dispatch.accepted",
          "GitHub 接受调试构建请求；等待 Run ID",
        );
      } catch (error: any) {
        // 4xx responses (except timeout) are definitive rejections. Network/5xx is ambiguous.
        if (
          error instanceof AppError &&
          [400, 401, 403, 404, 422, 429].includes(error.status)
        ) {
          task = this.store.task(id);
          task.state = "failed";
          task.error = error.message;
          this.store.save(task, "dispatch.rejected", error.message);
          return;
        }
        throw error;
      }
    }
    task = this.store.task(id);
    if (!task.runId) {
      const run = await this.planner.github.findRun(
        task.id,
        task.dispatchedAt!,
      );
      task = this.store.task(id);
      if (!run) {
        if (
          this.now() - Date.parse(task.dispatchedAt!) > 10 * 60_000 &&
          !task.error
        ) {
          task.error =
            "派发结果尚未确认。任务保持互斥并持续对账；请检查 GitHub，禁止重复启动。";
          this.store.save(task, "dispatch.uncertain", task.error);
        }
        return;
      }
      if (run.head_sha !== task.plan.workflowSha)
        throw new AppError(
          409,
          "实际 workflow SHA 与预检不符，请检查受保护的工作流分支",
        );
      task.runId = run.id;
      this.store.save(
        task,
        "run.attached",
        `Run ${run.id}；构建源码 SHA=${task.plan.sha}，工作流 SHA=${run.head_sha}`,
      );
    }
    if (task.cancelReason) await this.planner.github.cancel(task.runId!);
    const [run, jobs, artifacts] = await Promise.all([
      this.planner.github.run(task.runId!),
      this.planner.github.jobs(task.runId!),
      this.planner.github.artifacts(task.runId!),
    ]);
    task = this.store.task(id);
    task.jobs = jobs;
    task.artifacts = artifacts;
    task.error = undefined;
    if (run.status === "completed") {
      const missing = task.plan.platforms.filter(
        (p) =>
          !artifacts.some(
            (a) => a.name === `rc-debug-${task.id}-${p}` && !a.expired,
          ),
      );
      task.state =
        task.cancelReason ||
        (run.conclusion === "success" && missing.length === 0
          ? "succeeded"
          : "failed");
      if (task.state === "failed")
        task.error =
          run.conclusion !== "success"
            ? `部分或全部平台失败：${run.conclusion}`
            : `缺少调试产物：${missing.join(", ")}`;
    } else task.state = task.cancelReason ? "cancelling" : "running";
    const previous = this.store.task(id);
    if (
      JSON.stringify({ ...previous, updatedAt: "" }) !==
      JSON.stringify({ ...task, updatedAt: "" })
    )
      this.store.save(
        task,
        "run.progress",
        JSON.stringify({
          state: task.state,
          jobs,
          artifacts,
          error: task.error,
        }),
      );
  }
  private async verify(id: string) {
    let task = this.store.task(id);
    if (task.cancelReason || this.now() >= task.deadline) {
      task.state = task.cancelReason || "timed_out";
      this.store.save(task, "verification.stopped", "校验取消或超时");
      return;
    }
    const controller = new AbortController();
    this.verificationControllers.set(id, controller);
    const timer = setTimeout(
      () => {
        const current = this.store.task(id);
        if (!current.cancelReason && active(current)) {
          current.cancelReason = "timed_out";
          current.state = "cancelling";
          this.store.save(
            current,
            "verification.timeout",
            "校验超时；正在停止下载和本地校验",
          );
        }
        controller.abort(new Error("产物校验超时"));
      },
      Math.max(1, task.deadline - this.now()),
    );
    try {
      task.state = "running";
      task.verifications = [];
      task.error = undefined;
      this.store.save(
        task,
        "verification.started",
        `重新下载并复核源任务 ${task.sourceTaskId} 的全部所选平台；不执行远端写操作`,
      );
      const source = this.store.task(task.sourceTaskId!);
      const results = await verifyArtifacts(
        this.planner.github,
        source,
        controller.signal,
        (partial) => {
          const current = this.store.task(id);
          if (!current.cancelReason && !this.stopping) {
            current.verifications = partial;
            this.store.save(
              current,
              "artifact.verified",
              `${partial.at(-1)!.platform} archive、SHA-256 与更新元数据复核完成`,
            );
          }
        },
      );
      task = this.store.task(id);
      if (this.stopping) return;
      task.verifications = results;
      task.state = task.cancelReason || "succeeded";
      this.store.save(
        task,
        "verification.completed",
        "所选平台本机复核完成；尚未人工验收，不代表正式发布许可",
      );
    } catch (error: any) {
      task = this.store.task(id);
      if (this.stopping) {
        this.store.audit(
          id,
          "verification.interrupted",
          "服务重启后重新执行只读校验，不改变源构建任务",
        );
        return;
      }
      task.state = task.cancelReason || "failed";
      task.error = task.cancelReason ? undefined : error.message;
      this.store.save(task, "verification.stopped", task.error || task.state);
    } finally {
      clearTimeout(timer);
      this.verificationControllers.delete(id);
    }
  }
}
