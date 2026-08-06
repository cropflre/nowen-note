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
 *     出现（SQLite 启动时会自动 apply 迁移），若出现说明启动顺序异常。
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
import { getDbSchemaVersion, getCodeSchemaVersion } from "../db/schema";
import { serverInstanceRepository } from "../repositories";

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
      const manifest = JSON.parse(raw) as Record<string, { isEntry?: boolean; file?: string }>;
      for (const key of Object.keys(manifest)) {
        const entry = manifest[key];
        if (entry?.isEntry && entry.file) {
          const file = entry.file;
          cachedFrontendBuildId = file.substring(file.lastIndexOf("/") + 1);
          return cachedFrontendBuildId;
        }
      }
    } catch {
      // 继续尝试下一个候选。
    }
  }

  // 备选方案：直接扫 `frontend/dist/index.html` 中主入口脚本的 hash。
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
      // 继续尝试下一个候选。
    }
  }

  cachedFrontendBuildId = null;
  return cachedFrontendBuildId;
}

/** 解析最低兼容客户端版本号。 */
function resolveMinClientVersion(): string | null {
  const version = process.env.NOWEN_MIN_CLIENT_VERSION?.trim();
  return version || null;
}

/** 解析当前应用版本号。缓存进程级结果，避免每次请求都读取文件。 */
let cachedAppVersion: string | null = null;

function readPackageVersion(filePath: string, expectedNames: string[]): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const pkg = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      name?: string;
      version?: string;
    };
    if (pkg.version && expectedNames.includes(pkg.name || "")) return pkg.version;
  } catch {
    // Ignore and try the next candidate.
  }
  return null;
}

function resolveAppVersion(): string {
  if (cachedAppVersion) return cachedAppVersion;

  const forcedEnvVersion = process.env.NOWEN_APP_VERSION_OVERRIDE?.trim();
  if (forcedEnvVersion) {
    cachedAppVersion = forcedEnvVersion;
    return cachedAppVersion;
  }

  const packageCandidates: Array<{ path: string; names: string[] }> = [
    { path: path.resolve(process.cwd(), "package.json"), names: ["nowen-note"] },
    { path: path.resolve(process.cwd(), "../package.json"), names: ["nowen-note"] },
    {
      path: path.resolve(__dirname, "../../package.json"),
      names: ["nowen-note", "nowen-note-backend"],
    },
    { path: path.resolve(__dirname, "../../../package.json"), names: ["nowen-note"] },
    {
      path: path.resolve(process.cwd(), "backend/package.json"),
      names: ["nowen-note-backend"],
    },
    { path: path.resolve(__dirname, "../package.json"), names: ["nowen-note-backend"] },
  ];
  for (const candidate of packageCandidates) {
    const version = readPackageVersion(candidate.path, candidate.names);
    if (version) {
      cachedAppVersion = version;
      return cachedAppVersion;
    }
  }

  const legacyEnvVersion = process.env.NOWEN_APP_VERSION?.trim();
  if (legacyEnvVersion) {
    cachedAppVersion = legacyEnvVersion;
    return cachedAppVersion;
  }

  cachedAppVersion = "0.0.0";
  return cachedAppVersion;
}

/**
 * 解析当前后端实例的稳定唯一标识。
 *
 * 首次访问时生成候选值，并通过 INSERT ... ON CONFLICT DO NOTHING 保证
 * 多进程并发下不会覆盖已存在的实例标识；随后重新读取数据库中的胜出值。
 */
let cachedServerInstanceId: string | null | undefined = undefined;
let resolvingServerInstanceId: Promise<string | null> | undefined;

async function resolveServerInstanceId(): Promise<string | null> {
  if (cachedServerInstanceId !== undefined) return cachedServerInstanceId;
  if (resolvingServerInstanceId) return resolvingServerInstanceId;

  resolvingServerInstanceId = (async () => {
    try {
      const existing = await serverInstanceRepository.getAsync();
      if (existing) {
        cachedServerInstanceId = existing;
        return existing;
      }

      const candidate = crypto.randomUUID();
      await serverInstanceRepository.createIfAbsentAsync(candidate);
      cachedServerInstanceId = await serverInstanceRepository.getAsync() || candidate;
      return cachedServerInstanceId;
    } catch {
      cachedServerInstanceId = null;
      return null;
    } finally {
      resolvingServerInstanceId = undefined;
    }
  })();

  return resolvingServerInstanceId;
}

router.get("/", async (c) => {
  let schemaVersion: number | null = null;
  let codeSchemaVersion: number | null = null;
  try {
    schemaVersion = getDbSchemaVersion();
    codeSchemaVersion = getCodeSchemaVersion();
  } catch {
    // DB 未初始化或迁移失败时仍返回应用版本。
  }

  const buildTime = process.env.NOWEN_BUILD_TIME?.trim();
  const frontendBuildId = resolveFrontendBuildId();
  const minClientVersion = resolveMinClientVersion();
  const serverInstanceId = await resolveServerInstanceId();

  return c.json({
    appVersion: resolveAppVersion(),
    schemaVersion,
    codeSchemaVersion,
    ...(buildTime ? { buildTime } : {}),
    ...(frontendBuildId ? { frontendBuildId } : {}),
    ...(minClientVersion ? { minClientVersion } : {}),
    ...(serverInstanceId ? { serverInstanceId } : {}),
  });
});

export default router;
export { resolveAppVersion };
