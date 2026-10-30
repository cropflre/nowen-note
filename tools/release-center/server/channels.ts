import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  CHANNELS, RECEIPT_STATES,
  type ChannelId, type ChannelObservation, type ChannelHandoff,
  type ChannelView, type DistributionPlan, type DistributionReceipt,
  type DistributionSource, type DistributionAsset,
} from "../shared.ts";
import { Store } from "./store.ts";
import { GitHub } from "./github.ts";
import { AppError, redact, redactValue } from "./errors.ts";

const require = createRequire(import.meta.url);
const { STORE_IDENTITY } = require("../../../electron/storeIdentity.js");
const DOCKER_REPO = "cropflre/nowen-note";
const approvalBlocker = "Phase 2 正式审批与分发执行尚未接入；本计划不授予发布权限";

export interface ChannelAdapter {
  id: ChannelId;
  observe(version: string): Promise<ChannelObservation>;
  prepare(source: DistributionSource, observation: ChannelObservation): Promise<ChannelHandoff>;
}

export function channelVersion(value: unknown): string {
  if (typeof value !== "string" || value.length > 60 ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new AppError(400, "渠道版本必须为 X.Y.Z，不包含 v 前缀");
  return value;
}

function fields(raw: any, allowed: string[]) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).some((key) => !allowed.includes(key)))
    throw new AppError(400, "无效的渠道请求字段");
}
function requestKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{16,80}$/.test(value))
    throw new AppError(400, "无效幂等键");
  return value;
}
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha256 = (value: unknown): string | null =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) ? value : null;
const nasAssets = (source: DistributionSource) => source.assets.filter((a) => {
  const version = source.tag.slice(1).replaceAll(".", "\\.");
  return /\.(fpk|upk)$/i.test(a.name) && new RegExp(`(?:^|[-_])v?${version}(?:[-_.]|$)`).test(a.name);
});

export class Channels {
  readonly adapters: ChannelAdapter[];
  private refreshing = new Map<string, Promise<ChannelView>>();
  private planning = new Map<string, Promise<DistributionPlan>>();
  constructor(
    readonly store: Store,
    readonly github: GitHub,
    private config: { storeToken?: string } = {},
    private transport: typeof fetch = fetch,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_observations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, channel TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS channel_observations_version ON channel_observations(version,seq);
      CREATE TABLE IF NOT EXISTS distribution_plans (
        id TEXT PRIMARY KEY, requestKey TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, version TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS distribution_receipts (
        id TEXT PRIMARY KEY, requestKey TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, version TEXT NOT NULL, data TEXT NOT NULL);
    `);
    this.adapters = [
      { id: "microsoft-store", observe: (v) => this.storeStatus(v), prepare: (s, o) => this.storeHandoff(s, o) },
      { id: "docker-hub", observe: (v) => this.dockerStatus(v), prepare: async (s, o) => ({
        channel: "docker-hub", target: `${DOCKER_REPO}:${s.tag}`,
        blockers: [approvalBlocker, ...(o.evidence.tag
          ? ["目标 Tag 已存在，禁止本工具覆盖"] : ["本工具尚未核验待分发 OCI manifest、签名和构建来源"]),
          ...(["error", "unknown"].includes(o.state) ? ["目标状态未知，禁止据此执行分发"] : [])],
        instructions: ["正式审批后使用已有 Docker 发布流程；不得根据此计划自动推送或修改 latest", "部署引用应固定到经过核验的 manifest digest"],
        assets: [], metadata: { observed: o.evidence, observedAt: o.at },
      }) },
      { id: "nas", observe: (v) => this.nasStatus(v), prepare: async (s, o) => {
        const assets = nasAssets(s);
        return {
          channel: "nas", target: "飞牛 FPK / 绿联 UPK 手工分发",
          blockers: [approvalBlocker, ...(assets.length ? ["安装包内容、manifest、固件兼容和商店回执尚未核验"] : ["正式 Release 缺少该版本 FPK / UPK"]),
            ...assets.filter((a) => !a.digest).map((a) => `${a.name} 缺少 GitHub SHA-256 摘要`)],
          instructions: ["沿用 scripts/fpk/build-fpk.mjs 与 scripts/upk/build-upk.mjs；先验证包内版本、镜像 digest 与目标 NAS 固件", "包库存不代表应用商店已上架；平台回执需单独记录"],
          assets, metadata: { observation: o.evidence, observedAt: o.at },
        };
      } },
    ];
  }
  private safe(value: unknown) {
    return JSON.stringify(redactValue(value, [this.github.token, this.config.storeToken || ""]));
  }
  private async json(url: string, token = ""): Promise<any> {
    // URLs are constructed only by fixed provider adapters, never taken from UI/receipts.
    const response = await this.transport(url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(response.status, `渠道 API ${response.status}：${response.status === 401 || response.status === 403 ? "凭据无效或权限不足" : response.status === 429 ? "限流，请稍后刷新" : "查询失败"}`);
    }
    if (!response.body) throw new AppError(502, "渠道 API 返回空响应");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) throw new AppError(502, "渠道 API 响应超过上限");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new AppError(502, "渠道 API 返回无效 JSON"); }
  }
  private observation(channel: ChannelId, version: string, state: ChannelObservation["state"], summary: string,
    details: string[], url: string, evidence: Record<string, unknown> = {}): ChannelObservation {
    return { channel, version, state, summary, details, url, evidence, at: new Date().toISOString() };
  }
  private async source(version: string): Promise<DistributionSource> {
    const tag = `v${version}`;
    const release = await this.github.request(`releases/tags/${encodeURIComponent(tag)}`);
    if (release.draft !== false || release.prerelease !== false || release.tag_name !== tag ||
      !Number.isSafeInteger(release.id) || release.id <= 0 || typeof release.published_at !== "string" ||
      !Number.isFinite(Date.parse(release.published_at)))
      throw new AppError(409, "只接收已正式发布的同版本 Release；调试任务和 Draft 不能用作分发来源");
    let object = (await this.github.request(`git/ref/tags/${encodeURIComponent(tag)}`)).object;
    for (let depth = 0; object?.type === "tag" && depth < 5; depth++) {
      if (!/^[a-f0-9]{40}$/.test(object.sha)) throw new AppError(502, "无效 Tag SHA");
      object = (await this.github.request(`git/tags/${object.sha}`)).object;
    }
    if (object?.type !== "commit" || !/^[a-f0-9]{40}$/.test(object.sha))
      throw new AppError(409, "无法固定已发布 Tag 的 Commit");
    if (!Array.isArray(release.assets) || release.assets.length > 500)
      throw new AppError(502, "无效的 Release 产物清单");
    return {
      releaseId: release.id, tag, sha: object.sha,
      url: `https://github.com/cropflre/nowen-note/releases/tag/${tag}`, publishedAt: release.published_at,
      assets: release.assets.filter((a: any) => typeof a.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(a.name) &&
        Number.isSafeInteger(a.id) && Number.isSafeInteger(a.size) && a.size > 0)
        .map((a: any) => ({ id: a.id, name: a.name, size: a.size, digest: sha256(a.digest), contentVerified: false })),
    };
  }
  private async dockerStatus(version: string): Promise<ChannelObservation> {
    const url = `https://hub.docker.com/r/${DOCKER_REPO}/tags?name=v${version}`;
    try {
      const data = await this.json(`https://hub.docker.com/v2/namespaces/cropflre/repositories/nowen-note/tags/v${version}`);
      if (data.name !== `v${version}`) throw new AppError(502, "Docker Hub 返回的 Tag 不匹配");
      const images = (Array.isArray(data.images) ? data.images : []).slice(0, 64).map((i: any) => ({
        os: typeof i.os === "string" ? i.os : "unknown", architecture: typeof i.architecture === "string" ? i.architecture : "unknown",
        digest: sha256(i.digest), size: Number.isSafeInteger(i.size) ? i.size : null,
      }));
      const digest = sha256(data.digest);
      return this.observation("docker-hub", version, digest ? "available" : "unknown",
        digest ? "观察到版本 Tag 与 manifest digest" : "Tag 存在，但没有可用 manifest digest",
        ["只读 Hub 元数据；未下载镜像，也未核验构建 SHA、签名或镜像内容", "Tag 可能被外部修改；已有 Tag 禁止覆盖"], url,
        { repository: DOCKER_REPO, tag: data.name, digest, images, lastUpdated: data.last_updated || null });
    } catch (error) {
      if (error instanceof AppError && error.status === 404)
        return this.observation("docker-hub", version, "not_found", "未发现此版本 Docker Tag", [], url);
      throw error;
    }
  }
  private async storeStatus(version: string): Promise<ChannelObservation> {
    const url = `https://apps.microsoft.com/detail/${STORE_IDENTITY.storeId}`;
    if (!this.config.storeToken)
      return this.observation("microsoft-store", version, "not_configured", "未配置 Partner Center 查询凭据",
        ["AppX 构建成功不等于 Store 已上架", "服务端配置 NOWEN_RELEASE_STORE_ACCESS_TOKEN 后可查询提交状态；不接受浏览器输入 Token"], url,
        { storeId: STORE_IDENTITY.storeId, identityName: STORE_IDENTITY.identityName });
    const base = `https://manage.devcenter.microsoft.com/v1.0/my/applications/${STORE_IDENTITY.storeId}`;
    const app = await this.json(base, this.config.storeToken);
    if (app.id !== STORE_IDENTITY.storeId || app.packageIdentityName !== STORE_IDENTITY.identityName ||
      app.publisherName !== STORE_IDENTITY.publisher)
      throw new AppError(502, "Partner Center 返回的应用身份或 Publisher 不匹配");
    const ids = [...new Set([app.pendingApplicationSubmission?.id, app.lastPublishedApplicationSubmission?.id]
      .filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9-]{1,100}$/.test(id)))];
    const submissions = await Promise.all(ids.map(async (id) => {
      const submission = await this.json(`${base}/submissions/${id}`, this.config.storeToken);
      if (submission.id !== id) throw new AppError(502, "Partner Center 提交身份不匹配");
      return submission;
    }));
    const candidates = submissions.filter((s) => Array.isArray(s.applicationPackages) &&
      s.applicationPackages.some((p: any) => p.version === `${version}.0`));
    // A pending revision must never hide an already published version or relax its overwrite blocker.
    const matching = candidates.find((s) => s.status === "Published") || candidates[0];
    if (!matching)
      return this.observation("microsoft-store", version, "not_found", "当前可查询提交没有匹配的包版本",
        [`仅按 ${version}.0 关联；不会把其他版本的上架状态归入本版本`], url, { storeId: STORE_IDENTITY.storeId });
    const status = typeof matching.status === "string" ? matching.status : "Unknown";
    const state = status === "Published" ? "available" : /Failed|Rejected|Canceled/.test(status) ? "error"
      : /^(Pending|Commit|PreProcessing|Certification|Release)/.test(status) ? "pending" : "unknown";
    return this.observation("microsoft-store", version, state, `Partner Center：${status}`,
      ["只观察平台提交状态；不代表本工具已校验 AppX、签名或授予发布审批"], url,
      { storeId: STORE_IDENTITY.storeId, submissionId: matching.id, status, packageVersion: `${version}.0` });
  }
  private async nasStatus(version: string): Promise<ChannelObservation> {
    try {
      const source = await this.source(version);
      const assets = nasAssets(source);
      return this.observation("nas", version, assets.length ? "available" : "not_found",
        assets.length ? "正式 Release 中存在 NAS 安装包" : "正式 Release 中没有此版本 FPK / UPK",
        ["仅观察安装包库存；NAS 商店上架状态须通过平台回执另行记录", "未下载验证包内 manifest、镜像引用或固件兼容"], source.url,
        { sourceSha: source.sha, releaseId: source.releaseId, assets });
    } catch (error) {
      if (error instanceof AppError && [404, 409].includes(error.status))
        return this.observation("nas", version, "not_found", "没有可用于渠道分发的正式 Release", [],
          "https://github.com/cropflre/nowen-note/releases");
      throw error;
    }
  }
  private async storeHandoff(source: DistributionSource, observation: ChannelObservation): Promise<ChannelHandoff> {
    const runs = await this.github.list(`actions/workflows/microsoft-store-appx.yml/runs?head_sha=${source.sha}&status=completed`, "workflow_runs");
    const run = runs.find((r) => r.head_sha === source.sha && r.status === "completed" && r.conclusion === "success" &&
      r.path?.split("@")[0] === ".github/workflows/microsoft-store-appx.yml");
    const artifacts = run ? (await this.github.artifacts(run.id)).filter((a) => a.name === "nowen-note-store-appx" && !a.expired) : [];
    return {
      channel: "microsoft-store", target: STORE_IDENTITY.storeId,
      blockers: [approvalBlocker, ...(artifacts.length === 1 ? ["AppX 内容、签名、身份和版本尚未本机复核"] : ["未找到同 Commit 的唯一有效 Store AppX artifact"]),
        ...(observation.state === "available" ? ["Store 已观察到该包版本发布；不得以此计划覆盖"] : [])],
      instructions: ["只接收独立 Microsoft Store AppX 工作流；GitHub EXE 不能作为 Store 包", "正式审批与 AppX 内容验证完成后，在 Partner Center 核对身份和提交；本工具不执行上传或 commit"],
      assets: [], metadata: { identity: STORE_IDENTITY, runId: run?.id || null,
        artifacts: artifacts.map(({ id, name, digest, size }) => ({ id, name, digest, size, contentVerified: false })),
        providerObservation: observation.evidence, observedAt: observation.at },
    };
  }
  view(rawVersion: unknown): ChannelView {
    const version = channelVersion(rawVersion);
    const history = this.store.db.prepare("SELECT data FROM channel_observations WHERE version=? ORDER BY seq DESC LIMIT 60")
      .all(version).map((r) => JSON.parse(String(r.data)) as ChannelObservation);
    return {
      version, history, observations: CHANNELS.flatMap((id) => { const row = history.find((o) => o.channel === id); return row ? [row] : []; }),
      plans: this.store.db.prepare("SELECT data FROM distribution_plans WHERE version=? ORDER BY rowid DESC LIMIT 30")
        .all(version).map((r) => JSON.parse(String(r.data))),
      receipts: this.store.db.prepare("SELECT data FROM distribution_receipts WHERE version=? ORDER BY rowid DESC LIMIT 60")
        .all(version).map((r) => JSON.parse(String(r.data))),
      formalDistribution: false,
    };
  }
  refresh(raw: unknown): Promise<ChannelView> {
    fields(raw, ["version"]);
    const version = channelVersion((raw as any).version);
    const running = this.refreshing.get(version);
    if (running) return running;
    const recent = this.view(version);
    if (recent.observations.length === CHANNELS.length && recent.observations.every((o) => {
      const age = Date.now() - Date.parse(o.at);
      return age >= 0 && age < 60_000;
    }))
      return Promise.resolve(recent);
    const promise = (async () => {
      const results = await Promise.all(this.adapters.map(async (adapter) => {
        try { return await adapter.observe(version); }
        catch (error) {
          return this.observation(adapter.id, version, "error", "渠道查询失败；历史观察仍保留",
            [redact(error instanceof Error ? error.message : "未知错误", [this.github.token, this.config.storeToken || ""])], "");
        }
      }));
      this.store.transaction(() => {
        for (const result of results) this.store.db.prepare("INSERT INTO channel_observations(version,channel,data) VALUES(?,?,?)")
          .run(version, result.channel, this.safe(result));
        this.store.audit(null, "channels.observed", this.safe({ version, states: results.map((r) => ({ channel: r.channel, state: r.state })) }));
      });
      return this.view(version);
    })().finally(() => this.refreshing.delete(version));
    this.refreshing.set(version, promise);
    return promise;
  }
  private existing(table: "distribution_plans" | "distribution_receipts", key: string, hash: string): any {
    const row = this.store.db.prepare(`SELECT fingerprint,data FROM ${table} WHERE requestKey=?`).get(key);
    if (!row) return undefined;
    if (row.fingerprint !== hash) throw new AppError(409, "幂等键已用于其他渠道请求");
    return JSON.parse(String(row.data));
  }
  createPlan(raw: any): Promise<DistributionPlan> {
    fields(raw, ["version", "channels", "key"]);
    const version = channelVersion(raw.version);
    const key = requestKey(raw.key);
    if (!Array.isArray(raw.channels) || !raw.channels.length || raw.channels.length > CHANNELS.length ||
      new Set(raw.channels).size !== raw.channels.length || raw.channels.some((id: any) => !CHANNELS.includes(id)))
      throw new AppError(400, "请选择有效且不重复的渠道");
    const channels: ChannelId[] = [...raw.channels].sort();
    const hash = fingerprint({ version, channels });
    const existing = this.existing("distribution_plans", key, hash);
    if (existing) return Promise.resolve(existing);
    const inFlight = this.planning.get(key);
    if (inFlight) return inFlight.then(() => this.createPlan(raw));
    const id = randomUUID();
    this.store.audit(null, "distribution.plan_requested", this.safe({ id, version, channels }));
    const promise = (async () => {
      const source = await this.source(version);
      const observed = await this.refresh({ version });
      const handoffs = await Promise.all(channels.map(async (id) => {
        const adapter = this.adapters.find((a) => a.id === id)!;
        const observation = observed.observations.find((o) => o.channel === id)!;
        try { return await adapter.prepare(source, observation); }
        catch (error) {
          return { channel: id, target: id, blockers: [approvalBlocker, "适配器预检失败，禁止分发"], instructions: [], assets: [],
            metadata: { error: redact((error as Error).message, [this.github.token, this.config.storeToken || ""]) } };
        }
      }));
      const nas = handoffs.find((h) => h.channel === "nas");
      if (nas) {
        const docker = observed.observations.find((o) => o.channel === "docker-hub");
        const digest = sha256(docker?.evidence.digest);
        nas.metadata.containerReference = {
          tag: `${DOCKER_REPO}:${source.tag}`, pinnedReference: digest ? `${DOCKER_REPO}@${digest}` : null,
          observedAt: docker?.at || null, contentVerified: false,
        };
        nas.blockers.push(digest ? "NAS 包内镜像引用是否匹配该 digest 尚未核验" : "未取得可供 NAS 对账的 Docker manifest digest");
      }
      const plan: DistributionPlan = { id, version, createdAt: new Date().toISOString(), source, handoffs,
        executable: false, approval: "not_connected" };
      return this.store.transaction(() => {
        const previous = this.existing("distribution_plans", key, hash);
        if (previous) return previous;
        this.store.db.prepare("INSERT INTO distribution_plans VALUES(?,?,?,?,?)").run(plan.id, key, hash, version, this.safe(plan));
        this.store.audit(null, "distribution.planned", this.safe({ id: plan.id, version, sha: source.sha, channels, executable: false }));
        return JSON.parse(this.safe(plan));
      });
    })().catch((error) => {
      this.store.audit(null, "distribution.plan_failed", this.safe({ id, version, channels,
        error: error instanceof Error ? error.message : "生成交接计划失败" }));
      throw error;
    }).finally(() => this.planning.delete(key));
    this.planning.set(key, promise);
    return promise;
  }
  record(raw: any): DistributionReceipt {
    fields(raw, ["planId", "channel", "key", "version", "sha", "status", "reference", "evidenceUrl", "notes", "confirmManual"]);
    const key = requestKey(raw.key);
    if (typeof raw.planId !== "string" || !/^[a-f0-9-]{36}$/.test(raw.planId) || !["microsoft-store", "nas"].includes(raw.channel) ||
      !RECEIPT_STATES.includes(raw.status) || raw.confirmManual !== true ||
      typeof raw.reference !== "string" || !raw.reference.trim() || raw.reference.length > 160 ||
      typeof raw.notes !== "string" || raw.notes.length > 4000 || typeof raw.evidenceUrl !== "string" || raw.evidenceUrl.length > 2000)
      throw new AppError(400, "请填写平台回执并确认这是未核实的人工记录");
    const url = URL.parse(raw.evidenceUrl);
    if (!url || url.protocol !== "https:" || url.username || url.password || url.hash || url.search)
      throw new AppError(400, "证据链接必须为不含查询参数、凭据或片段的 HTTPS URL；服务端不会访问它");
    const row = this.store.db.prepare("SELECT data FROM distribution_plans WHERE id=?").get(raw.planId);
    if (!row) throw new AppError(404, "分发计划不存在");
    const plan = JSON.parse(String(row.data)) as DistributionPlan;
    if (raw.version !== plan.version || raw.sha !== plan.source.sha || !plan.handoffs.some((h) => h.channel === raw.channel))
      throw new AppError(409, "人工回执的版本、Commit 或渠道与计划不符");
    const hash = fingerprint({ planId: plan.id, channel: raw.channel, version: plan.version, sha: plan.source.sha,
      status: raw.status, reference: raw.reference.trim(), evidenceUrl: url.href, notes: raw.notes });
    return this.store.transaction(() => {
      const previous = this.existing("distribution_receipts", key, hash);
      if (previous) return previous;
      const receipt: DistributionReceipt = {
        id: randomUUID(), planId: plan.id, channel: raw.channel, version: plan.version, sha: plan.source.sha,
        at: new Date().toISOString(), status: raw.status, reference: raw.reference.trim(), evidenceUrl: url.href,
        notes: raw.notes, source: "maintainer-report", verifiedByProvider: false,
      };
      this.store.db.prepare("INSERT INTO distribution_receipts VALUES(?,?,?,?,?)").run(receipt.id, key, hash, plan.version, this.safe(receipt));
      this.store.audit(null, "distribution.receipt_recorded", this.safe({ ...receipt, permissionGranted: false }));
      return JSON.parse(this.safe(receipt));
    });
  }
}
