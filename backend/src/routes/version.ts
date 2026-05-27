/**
 * GET /api/version —— 公开的版本信息端点
 * ---------------------------------------------------------------------------
 *
 * 用途：
 *   - 前端 UpdateNotifier 轮询本端，发现"服务器 appVersion 与浏览器缓存里
 *     编译期注入的 __APP_VERSION__ 不一致"时，提示用户刷新以加载新前端；
 *   - 关于页 / 设置面板展示"当前运行的后端版本、Schema 版本、与最新 release 对比"；
 *   - 运维脚本巡检 `curl /api/version` 快速判断实例状态。
 *
 * 设计取舍：
 *   - **无需鉴权**：与 /api/health 同级，挂在 JWT 中间件之前。版本号不是机密，
 *     且前端在登录页就需要读取，中间件里放不下这类"匿名访问"。
 *   - **appVersion 取值顺序**：显式覆盖 ENV > 镜像/源码内 package.json > 旧 ENV 兜底。
 *       - `NOWEN_APP_VERSION_OVERRIDE`：仅给高级运维强制覆盖使用；
 *       - 根 package.json：Docker 镜像 / 源码态 / Vite / Electron 共用的版本真相源；
 *       - backend/package.json：历史兼容兜底；
 *       - `NOWEN_APP_VERSION`：只作旧镜像/旧脚本最后兜底，不能优先于包内版本。
 *         原因：NAS / 应用市场更新时可能保留旧容器 ENV，若 ENV 优先，会出现
 *         "前端已是新版、服务端版本号仍停在旧版"，用户只能删除重装。
 *   - **Schema 版本**：透传 getDbSchemaVersion / getCodeSchemaVersion，
 *     分别是"库实际应用到的最高迁移版本"与"当前代码已知的最高迁移版本"。
 *     两者相等说明迁移已落地；codeSchemaVersion > schemaVersion 理论上不会
 *     出现（getDb 启动时会自动 apply 迁移），若出现说明启动顺序异常。
 *   - **buildTime 可选**：发布流水线写入 `NOWEN_BUILD_TIME`（ISO 字符串）
 *     时透传；未注入时省略字段，避免前端误以为存在但为空。
 *
 * 与 /api/releases/latest 的分工：
 *   - /api/version：描述"当前实例自己"
 *   - /api/releases/latest：描述"GitHub 最新 release"
 *   前端拿两者做对比后决定是否提示更新。
 */

import { Hono } from "hono";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getDb, getDbSchemaVersion, getCodeSchemaVersion } from "../db/schema";

const router = new Hono();

/**
 * 解析"当前实例正在托管的前端 bundle 标识"。
 *
 * 动机（H2 修复）：
 *   UpdateNotifier 旧逻辑是拿服务端 `appVersion`（= package.json 里的版本号）
 *   与编译期注入的 `__APP_VERSION__` 比对。这在"只升后端忘推前端"的部署里
 *   会把用户卡在"刷新 loop"——因为前端包版本号没跟着变，`__APP_VERSION__` 永远
 *   和服务端 `appVersion` 对不上，用户刷 N 次还是旧 bundle。
 *
 * 这里给出一个"**只要前端 bundle 真变了，这个字段就一定变**"的稳态信号：
 *   读取 `frontend/dist/.vite/manifest.json` 的入口 chunk（`isEntry=true`）的
 *   `file` 字段（形如 `assets/index-abc123.js`），Vite 会把产物 hash 硬编码进
 *   文件名；任何源代码改动都会产生新 hash，也就是新的 buildId。
 *
 * 解析路径顺序（与 appVersion 的候选列表思路一致，适配 dev / docker / 源码态）：
 *   1. ENV 显式注入（CI 构建时写 `NOWEN_FRONTEND_BUILD_ID`，最确定）
 *   2. 同仓库 `frontend/dist/.vite/manifest.json`（docker / npm run build 后）
 *   3. 回退 null —— 前端此时会降级到原来的 appVersion 比对逻辑
 *
 * 缓存：进程级，避免每次请求都 fs.readFileSync。若运维需要"不重启换包热生效"，
 * 应当重启进程——这是容器部署的默认假设，不必为此牺牲接口性能。
 */
let cachedFrontendBuildId: string | null | undefined = undefined;
function resolveFrontendBuildId(): string | null {
  if (cachedFrontendBuildId !== undefined) return cachedFrontendBuildId;

  const envId = process.env.NOWEN_FRONTEND_BUILD_ID?.trim();
  if (envId) {
    cachedFrontendBuildId = envId;
    return cachedFrontendBuildId;
  }

  // 几个可能的 manifest 位置——dev 态 cwd 是根；docker 里 cwd 是 /app 或 backend/。
  // .vite/manifest.json 只有在 vite.config 开启 build.manifest=true 时才生成；
  // 本项目没开，故主路径走 index.html 的 hash 提取作为 buildId（见下）。
  const candidates = [
    path.resolve(process.cwd(), "frontend/dist/.vite/manifest.json"),
    path.resolve(process.cwd(), "../frontend/dist/.vite/manifest.json"),
    path.resolve(__dirname, "../../../frontend/dist/.vite/manifest.json"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf-8");
      const m = JSON.parse(raw) as Record<string, { isEntry?: boolean; file?: string }>;
      // 找 isEntry=true 的第一个条目（通常是 index.html 入口）
      for (const key of Object.keys(m)) {
        const entry = m[key];
        if (entry?.isEntry && entry.file) {
          // 与前端 `detectClientBuildId()` 口径对齐：只保留文件名（含 hash）
          const f = entry.file;
          cachedFrontendBuildId = f.substring(f.lastIndexOf("/") + 1);
          return cachedFrontendBuildId;
        }
      }
    } catch {
      // 继续尝试下一个候选
    }
  }

  // 备选方案：直接扫 `frontend/dist/index.html` 中主入口脚本的 hash。
  // 生产构建 index.html 里必然有 <script type="module" crossorigin src="/assets/index-<hash>.js"></script>，
  // 抓这串路径并**只保留文件名**，与前端 `detectClientBuildId()` 取值口径一致
  // （前端运行时也只取最后一段文件名），避免 CDN / baseUrl 变化或代理路径
  // 差异导致两边对不上引发误提示。
  const indexCandidates = [
    path.resolve(process.cwd(), "frontend/dist/index.html"),
    path.resolve(process.cwd(), "../frontend/dist/index.html"),
    path.resolve(__dirname, "../../../frontend/dist/index.html"),
  ];
  for (const p of indexCandidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const html = fs.readFileSync(p, "utf-8");
      const match = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/i);
      if (match && match[1]) {
        const src = match[1].split("?")[0].split("#")[0];
        cachedFrontendBuildId = src.substring(src.lastIndexOf("/") + 1);
        return cachedFrontendBuildId;
      }
    } catch {
      // 继续尝试下一个候选
    }
  }

  cachedFrontendBuildId = null;
  return cachedFrontendBuildId;
}

/**
 * 解析"最低兼容客户端版本号"。
 *
 * 用于 Android 原生壳的硬性升级引导：当 `__APP_VERSION__` < `minClientVersion`
 * 时，前端 UpdateNotifier 会退出可关闭的"软提示"形态，改成不可关闭的"请到
 * 官网下载新 APK"卡片——因为 Android WebView 里只刷 JS bundle 解决不了原生
 * plugin 不兼容（权限/签名/API 变更）。
 *
 * 来源：
 *   - ENV `NOWEN_MIN_CLIENT_VERSION`（最低兼容版本，例："1.0.30"）
 *   - 未配置则返回 null，前端据此走软提示路径，完全向后兼容
 *
 * 为什么不存 DB：这类运维旋钮生命周期与部署绑定；放在 ENV 里改完重启生效，
 * 与当前"改迁移要重启"的运维心智一致。若将来要前端 UI 配置再平移到 DB。
 */
function resolveMinClientVersion(): string | null {
  const v = process.env.NOWEN_MIN_CLIENT_VERSION?.trim();
  return v || null;
}

/**
 * 解析当前应用版本号。缓存进程级结果，避免每次请求都 fs.readFileSync。
 * 读文件抛错时静默降级，用 fallback 字符串；这个接口要"永远能答"。
 */
let cachedAppVersion: string | null = null;

function readPackageVersion(filePath: string, expectedNames: string[]): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const pkg = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { name?: string; version?: string };
    if (pkg.version && expectedNames.includes(pkg.name || "")) return pkg.version;
  } catch {
    // ignore and try next candidate
  }
  return null;
}

function resolveAppVersion(): string {
  if (cachedAppVersion) return cachedAppVersion;

  // 1) 显式强制覆盖：仅给高级运维使用。普通 NOWEN_APP_VERSION 不再优先，
  // 避免 NAS / 应用市场复用旧容器 ENV 时把服务端版本钉死在旧值。
  const forcedEnvVer = process.env.NOWEN_APP_VERSION_OVERRIDE?.trim();
  if (forcedEnvVer) {
    cachedAppVersion = forcedEnvVer;
    return cachedAppVersion;
  }

  // 2) 优先读镜像 / 源码内 package.json。Dockerfile 会把根 package.json 复制到
  // /app/package.json；源码态 / Electron / backend/dist 也通过候选路径覆盖。
  const packageCandidates: Array<{ path: string; names: string[] }> = [
    { path: path.resolve(process.cwd(), "package.json"), names: ["nowen-note"] },
    { path: path.resolve(process.cwd(), "../package.json"), names: ["nowen-note"] },
    { path: path.resolve(__dirname, "../../package.json"), names: ["nowen-note", "nowen-note-backend"] },
    { path: path.resolve(__dirname, "../../../package.json"), names: ["nowen-note"] },
    { path: path.resolve(process.cwd(), "backend/package.json"), names: ["nowen-note-backend"] },
    { path: path.resolve(__dirname, "../package.json"), names: ["nowen-note-backend"] },
  ];
  for (const candidate of packageCandidates) {
    const v = readPackageVersion(candidate.path, candidate.names);
    if (v) {
      cachedAppVersion = v;
      return cachedAppVersion;
    }
  }

  // 3) 旧构建链路兜底：只有包内版本完全读不到时，才信任 NOWEN_APP_VERSION。
  const legacyEnvVer = process.env.NOWEN_APP_VERSION?.trim();
  if (legacyEnvVer) {
    cachedAppVersion = legacyEnvVer;
    return cachedAppVersion;
  }

  cachedAppVersion = "0.0.0";
  return cachedAppVersion;
}

/**
 * 解析"当前后端实例"的稳定唯一标识 `serverInstanceId`。
 * ---------------------------------------------------------------------------
 * 背景（v1.1.7 修复）：
 *   1.1.6 的"登录云端账号迁移向导"在用户**对同一台后端**点击迁移时，会把本地
 *   笔记本/笔记/附件再上传到同一台机器上，产生一份完全相同的副本。用户随后
 *   清理副本时，因为 hash 去重让多笔记共享同一物理文件，删除回收站会把还
 *   活着的笔记引用的图片一起 unlink 掉。
 *
 * 修复策略需要前端在迁移前能识别"本地端 == 云端"。最廉价可靠的标识就是给
 * 每个进程实例分配一个一次性 UUID，落库后跨重启稳定，前端拉两端 /api/version
 * 比对即可。
 *
 * 实现：
 *   - 落在 system_settings 表（已有的 KV 表），key = `server_instance_id`。
 *   - 首次访问 lazy 生成 + 落库；之后任何重启都从库里读出来。
 *   - 进程级缓存避免每次请求都查 DB。
 *   - 任何异常都返回 null（接口不会因为这一项崩掉）。
 */
let cachedServerInstanceId: string | null | undefined = undefined;
function resolveServerInstanceId(): string | null {
  if (cachedServerInstanceId !== undefined) return cachedServerInstanceId;
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM system_settings WHERE key = ?")
      .get("server_instance_id") as { value: string } | undefined;
    if (row?.value) {
      cachedServerInstanceId = row.value;
      return cachedServerInstanceId;
    }
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)",
    ).run("server_instance_id", id);
    // 极端并发下另一个进程已经写入，再读一次以使用胜出者的值
    const row2 = db
      .prepare("SELECT value FROM system_settings WHERE key = ?")
      .get("server_instance_id") as { value: string } | undefined;
    cachedServerInstanceId = row2?.value || id;
    return cachedServerInstanceId;
  } catch {
    cachedServerInstanceId = null;
    return cachedServerInstanceId;
  }
}

router.get("/", (c) => {
  let schemaVersion: number | null = null;
  let codeSchemaVersion: number | null = null;
  try {
    schemaVersion = getDbSchemaVersion();
    codeSchemaVersion = getCodeSchemaVersion();
  } catch {
    // DB 未初始化或迁移失败时这里读不到；接口仍然返回 appVersion，
    // 前端据此也能工作（只是不能展示 schema 信息）。
  }

  const buildTime = process.env.NOWEN_BUILD_TIME?.trim();
  const frontendBuildId = resolveFrontendBuildId();
  const minClientVersion = resolveMinClientVersion();
  const serverInstanceId = resolveServerInstanceId();

  return c.json({
    appVersion: resolveAppVersion(),
    schemaVersion,
    codeSchemaVersion,
    ...(buildTime ? { buildTime } : {}),
    // 仅当真的解析到时才返回字段，避免前端误判"有字段 == 已部署新方案"。
    // 前端逻辑：frontendBuildId 有值优先用它比对，否则降级到 appVersion。
    ...(frontendBuildId ? { frontendBuildId } : {}),
    ...(minClientVersion ? { minClientVersion } : {}),
    // serverInstanceId：1.1.7 起用于"登录云端账号"迁移向导识别同源后端，
    // 阻止用户把数据迁移到同一台机器（会造成双份数据）。
    ...(serverInstanceId ? { serverInstanceId } : {}),
  });
});

export default router;
export { resolveAppVersion };
