/**
 * SenseVoice 容器生命周期管理器
 * ---------------------------------------------------------------------------
 * 核心策略：SenseVoiceSmall 模型约 330MB，不应常驻内存。
 * 仅在需要转写时临时拉起的容器，空闲 5 分钟后自动销毁。
 *
 * 使用方式：
 *   import { sensevoiceManager } from "../services/sensevoice-manager";
 *   await sensevoiceManager.ensureRunning();  // 确保容器在线
 *   // ... 调用转写 API ...
 *   sensevoiceManager.resetIdleTimer();        // 延长空闲计时
 *
 * 依赖：
 *   - Docker CLI（docker）需要在容器内可用
 *   - /var/run/docker.sock 需要挂载到容器
 *   - nowen-note-sensevoice 镜像需已构建
 */

const SENSEVOICE_CONTAINER = "nowen-note-sensevoice";
const SENSEVOICE_IMAGE = "nowen-note-sensevoice:latest";
const SENSEVOICE_URL = "http://sensevoice:8000/v1/audio/transcriptions";
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟空闲超时
const STARTUP_TIMEOUT_MS = 60 * 1000;   // 容器启动最大等待时间
const HEALTH_CHECK_INTERVAL = 1000;      // 健康检查间隔

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let isStarting = false;

/**
 * 检查 SenseVoice 容器是否在运行（通过 Docker CLI）
 */
function isContainerRunning(): boolean {
  try {
    const { execSync } = require("child_process");
    const status = execSync(
      `docker inspect --format='{{.State.Status}}' ${SENSEVOICE_CONTAINER} 2>/dev/null || echo "not_found"`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    return status === "running";
  } catch {
    return false;
  }
}

/**
 * 检查 SenseVoice HTTP 服务是否就绪
 */
async function isServiceReady(): Promise<boolean> {
  try {
    const res = await fetch(SENSEVOICE_URL, { method: "OPTIONS", signal: AbortSignal.timeout(3000) });
    return res.ok || res.status === 405; // 405 = Method Not Allowed 但服务在线
  } catch {
    return false;
  }
}

/**
 * 启动 SenseVoice 容器并等待就绪
 */
async function startContainer(): Promise<void> {
  const { execSync } = require("child_process");

  // 先尝试清理残留
  try {
    execSync(`docker rm -f ${SENSEVOICE_CONTAINER} 2>/dev/null`, { timeout: 5000 });
  } catch { /* ignore */ }

  // 启动新容器（连接到默认 compose 网络以便被 nowen-note 访问）
  const networkName = process.env.SENSEVOICE_NETWORK || "nowen-note_default";
  execSync(
    `docker run -d --name ${SENSEVOICE_CONTAINER} ` +
    `--network ${networkName} ` +
    `-v sensevoice-model-cache:/app/modelscope_cache ` +
    `${SENSEVOICE_IMAGE}`,
    { timeout: 30000, stdio: "pipe" },
  );
}

/**
 * 停止 SenseVoice 容器
 */
function stopContainer(): void {
  const { execSync } = require("child_process");
  try {
    execSync(`docker stop ${SENSEVOICE_CONTAINER} --time=10 2>/dev/null`, { timeout: 15000 });
    execSync(`docker rm ${SENSEVOICE_CONTAINER} 2>/dev/null`, { timeout: 10000 });
  } catch { /* ignore */ }
}

/**
 * 清理空闲计时器
 */
function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/**
 * 重置空闲计时器（每次调用转写后调用）
 */
export function resetIdleTimer(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    console.log("[sensevoice] idle timeout, stopping container...");
    stopContainer();
    clearIdleTimer();
  }, IDLE_TIMEOUT_MS);
  idleTimer.unref();
}

/**
 * 确保 SenseVoice 容器正在运行且就绪
 * 如果容器未运行 → 启动 → 等待就绪 → 返回
 * 如果已运行 → 直接返回
 */
export async function ensureRunning(): Promise<void> {
  // 快速路径：HTTP 就绪
  if (await isServiceReady()) {
    resetIdleTimer();
    return;
  }

  // 避免并发启动
  if (isStarting) {
    // 等待启动完成
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL));
      if (await isServiceReady()) {
        resetIdleTimer();
        return;
      }
    }
    throw new Error("SenseVoice 启动超时（被另一线程启动）");
  }

  isStarting = true;
  try {
    console.log("[sensevoice] container not ready, starting...");

    // Docker 方式启动
    if (!isContainerRunning()) {
      await startContainer();
    }

    // 等待就绪
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL));
      if (await isServiceReady()) {
        ready = true;
        break;
      }
    }

    if (!ready) {
      throw new Error("SenseVoice 启动超时（60s）");
    }

    console.log("[sensevoice] ready");
    resetIdleTimer();
  } catch (e) {
    console.error("[sensevoice] start failed:", e);
    throw e;
  } finally {
    isStarting = false;
  }
}

/**
 * 强制停止 SenseVoice（用于进程退出时清理）
 */
export function forceStop(): void {
  clearIdleTimer();
  stopContainer();
}
