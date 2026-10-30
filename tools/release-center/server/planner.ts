import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  PLATFORMS,
  WORKFLOW,
  type Check,
  type Plan,
  type PlanInput,
  type Overview,
} from "../shared.ts";
import { AppError, redact } from "./errors.ts";
import { GitHub } from "./github.ts";

export function validateInput(value: any): PlanInput {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some(
      (k) =>
        !["branch", "version", "channel", "platforms", "notes"].includes(k),
    )
  )
    throw new AppError(400, "无效的计划字段");
  if (
    typeof value.branch !== "string" ||
    value.branch.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.branch) ||
    /\.\.|\/\/|\/$|\.lock$/.test(value.branch)
  )
    throw new AppError(400, "无效分支名");
  const number = "(?:0|[1-9][0-9]*)";
  if (
    typeof value.version !== "string" ||
    value.version.length > 60 ||
    !new RegExp(
      `^${number}\\.${number}\\.${number}(?:-(?:alpha|beta|rc)\\.${number})?$`,
    ).test(value.version)
  )
    throw new AppError(
      400,
      "版本必须为 X.Y.Z 或 X.Y.Z-rc.N / beta.N / alpha.N",
    );
  if (
    !["stable", "prerelease"].includes(value.channel) ||
    (value.channel === "stable") !== !value.version.includes("-")
  )
    throw new AppError(400, "渠道与版本后缀不一致");
  if (
    !Array.isArray(value.platforms) ||
    !value.platforms.length ||
    value.platforms.length > 3 ||
    new Set(value.platforms).size !== value.platforms.length ||
    value.platforms.some((p: any) => !PLATFORMS.includes(p))
  )
    throw new AppError(400, "请选择有效且不重复的桌面平台");
  if (typeof value.notes !== "string" || value.notes.length > 20_000)
    throw new AppError(400, "发布说明超过长度限制");
  return {
    branch: value.branch,
    version: value.version,
    channel: value.channel,
    platforms: [...value.platforms].sort(),
    notes: value.notes,
  };
}

export function versionChecks(
  files: Record<string, string>,
  version: string,
): Check[] {
  return Object.entries(files).map(([path, content]) => {
    try {
      const data = path.endsWith(".json") ? JSON.parse(content) : undefined;
      const values = data
        ? [
            data.version,
            ...(path.endsWith("package-lock.json")
              ? [data.packages?.[""]?.version]
              : []),
          ]
        : [content.match(/versionName\s+["']([^"']+)/)?.[1]];
      return {
        name: path,
        status: values.every((v) => v === version) ? "pass" : "fail",
        detail: `期望 ${version}；实际 ${values.join(" / ") || "缺失"}`,
      };
    } catch {
      return { name: path, status: "fail", detail: "版本文件无法解析" };
    }
  });
}

export class Planner {
  constructor(
    readonly root: string,
    readonly github: GitHub,
    readonly workflowRef: string,
    readonly debugEnabled: boolean,
  ) {}
  local() {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: this.root,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    return {
      branch: git("branch", "--show-current"),
      localSha: git("rev-parse", "HEAD"),
      dirty: !!git("status", "--porcelain"),
      localVersion: JSON.parse(
        readFileSync(join(this.root, "package.json"), "utf8"),
      ).version,
    };
  }
  async overview(): Promise<Omit<Overview, "tasks">> {
    const result: Omit<Overview, "tasks"> = {
      ...this.local(),
      repo: "cropflre/nowen-note",
      tokenConfigured: !!this.github.token,
      debugEnabled: this.debugEnabled,
      releases: [],
      branches: [],
      runs: [],
    };
    const responses = await Promise.allSettled([
      this.github.releases(),
      this.github.list("branches"),
      this.github.runs(),
    ]);
    if (responses[0].status === "fulfilled")
      result.releases = responses[0].value;
    if (responses[1].status === "fulfilled")
      result.branches = responses[1].value.map((b: any) => b.name);
    if (responses[2].status === "fulfilled") result.runs = responses[2].value;
    result.githubError =
      responses
        .filter((r) => r.status === "rejected")
        .map((r) =>
          redact(String((r as PromiseRejectedResult).reason.message), [
            this.github.token,
          ]),
        )
        .join("；") || undefined;
    return result;
  }
  async workflowCheck(): Promise<string> {
    const workflowSha = await this.github.resolve(this.workflowRef);
    const [remote, state] = await Promise.all([
      this.github.content(`.github/workflows/${WORKFLOW}`, workflowSha),
      this.github.request(`actions/workflows/${WORKFLOW}`),
    ]);
    const installed = readFileSync(
      join(this.root, ".github/workflows", WORKFLOW),
      "utf8",
    );
    if (
      remote.replace(/\r\n/g, "\n") !== installed.replace(/\r\n/g, "\n") ||
      state.state !== "active"
    )
      throw new AppError(409, "调试工作流与服务端审计版本不一致或尚未启用");
    return workflowSha;
  }
  async conflicts(version: string): Promise<Check[]> {
    const tag = encodeURIComponent(`v${version}`);
    const [tagExists, releases] = await Promise.all([
      this.github.exists(`git/ref/tags/${tag}`),
      this.github.list("releases"),
    ]);
    // The release-by-tag API is insufficient for unpublished drafts without a tag.
    const releaseExists = releases.some((r) => r.tag_name === `v${version}`);
    return [
      {
        name: "Tag 冲突",
        status: tagExists ? "fail" : "pass",
        detail: tagExists
          ? `v${version} 已存在；禁止覆盖`
          : `v${version} 尚不存在`,
      },
      {
        name: "Release 冲突",
        status: releaseExists ? "fail" : "pass",
        detail: releaseExists
          ? "同版本 Release 已存在；禁止覆盖"
          : "未发现同版本 Release",
      },
    ];
  }
  async create(raw: unknown): Promise<Plan> {
    const input = validateInput(raw);
    const checks: Check[] = [];
    let sha = "";
    let workflowSha = "";
    let verifierReady = false;
    try {
      sha = await this.github.resolve(input.branch);
      checks.push({ name: "固定 Commit", status: "pass", detail: sha });
      const paths = [
        "package.json",
        "package-lock.json",
        "backend/package.json",
        "backend/package-lock.json",
        "frontend/android/app/build.gradle",
      ];
      const files = await Promise.all(
        paths.map(
          async (path) => [path, await this.github.content(path, sha)] as const,
        ),
      );
      checks.push(
        ...versionChecks(Object.fromEntries(files), input.version),
        ...(await this.conflicts(input.version)),
      );
      const checksAtSha = await this.github.list(
        `commits/${sha}/check-runs`,
        "check_runs",
      );
      const required = ["CI", "Build", "Test"];
      const relevant = checksAtSha.filter((c: any) =>
        required.some((n) => c.name.toLowerCase().includes(n.toLowerCase())),
      );
      checks.push({
        name: "关键 CI（只读证据）",
        status:
          relevant.length &&
          relevant.every(
            (c: any) => c.status === "completed" && c.conclusion === "success",
          )
            ? "pass"
            : "unknown",
        detail: relevant.length
          ? relevant
              .map((c: any) => `${c.name}: ${c.conclusion || c.status}`)
              .join("；")
          : "未发现该 SHA 的关键测试结果；调试 workflow 将运行发布契约。正式发布仍须单独审批。",
      });
    } catch (error) {
      checks.push({
        name: "GitHub 预检",
        status: "unknown",
        detail: redact((error as Error).message, [this.github.token]),
      });
    }
    if (sha) {
      try {
        const paths = [
          "scripts/release-center-assets.mjs",
          "scripts/lib/release-platform-assets.cjs",
        ];
        const compatible = await Promise.all(
          paths.map(async (path) => {
            const remote = await this.github.content(path, sha);
            const installed = readFileSync(join(this.root, path), "utf8");
            return (
              remote.replace(/\r\n/g, "\n") === installed.replace(/\r\n/g, "\n")
            );
          }),
        );
        verifierReady = compatible.every(Boolean);
        checks.push({
          name: "调试产物协议",
          status: verifierReady ? "pass" : "unknown",
          detail: verifierReady
            ? "固定源码 SHA 中的 manifest 生成器和平台清单与已审计版本一致"
            : "候选源码的 manifest 生成器或平台清单不同，需要审查并更新服务端版本",
        });
      } catch (error) {
        checks.push({
          name: "调试产物协议",
          status: "unknown",
          detail: redact((error as Error).message, [this.github.token]),
        });
      }
    }
    try {
      workflowSha = await this.workflowCheck();
      checks.push({
        name: "隔离调试工作流",
        status: "pass",
        detail: `${this.workflowRef} @ ${workflowSha}`,
      });
    } catch (error) {
      checks.push({
        name: "隔离调试工作流",
        status: "unknown",
        detail: redact((error as Error).message, [this.github.token]),
      });
    }
    checks.push({
      name: "服务端调试配置",
      status: this.github.token && this.debugEnabled ? "pass" : "unknown",
      detail:
        this.github.token && this.debugEnabled
          ? "服务端已配置 Token 与调试开关；GitHub Actions 写权限最终由 API 校验"
          : "需要服务端 Token（Contents 读、Actions 写）和 NOWEN_RELEASE_DEBUG=1",
    });
    checks.push({
      name: "调试渠道兼容性",
      status: input.channel === "stable" ? "pass" : "unknown",
      detail:
        input.channel === "stable"
          ? "使用已有 latest 更新元数据校验"
          : "预发布支持计划预览和 Dry Run；预发布更新渠道适配尚未实现，暂不派发构建",
    });
    checks.push({
      name: "正式发布审批",
      status: "unknown",
      detail: "Phase 1 不支持正式发布；此计划不代表发版许可",
    });
    const ready =
      !!sha &&
      !checks.some((c) => c.status === "fail") &&
      !checks.some((c) => c.name === "GitHub 预检");
    return {
      ...input,
      id: randomUUID(),
      sha,
      createdAt: new Date().toISOString(),
      checks,
      ready,
      debugReady:
        ready &&
        input.channel === "stable" &&
        verifierReady &&
        !!workflowSha &&
        !!this.github.token &&
        this.debugEnabled,
      workflowRef: this.workflowRef,
      workflowSha,
      effects: [
        "Dry Run：只检查版本、冲突与计划，无远端写操作",
        "调试构建：仅选择的平台，固定 Commit，未签名 Full 安装包与调试 artifact",
        "不会推 Tag、创建 Release、上传 TestFlight / Docker / 商店",
        "现有通用 Tag 会触发桌面全平台和 iOS TestFlight；Phase 1 禁止该路径",
      ],
    };
  }
}
