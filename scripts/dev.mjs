import net from "node:net"
import path from "node:path"
import process from "node:process"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const scriptsDir = path.dirname(__filename)
const rootDir = path.resolve(scriptsDir, "..")
const backendDir = path.join(rootDir, "backend")
const frontendDir = path.join(rootDir, "frontend")

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()

    server.unref()
    server.once("error", () => resolve(false))
    server.listen({ port, host: "0.0.0.0", exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

async function findAvailablePort(startPort, excludedPorts = new Set()) {
  for (let port = startPort; port <= 65535; port += 1) {
    if (excludedPorts.has(port)) continue
    if (await isPortAvailable(port)) return port
  }

  throw new Error(`从 ${startPort} 开始未找到可用端口`)
}

function assertFile(filePath, installHint) {
  if (!existsSync(filePath)) {
    console.error(`\n[dev] 缺少依赖文件：${path.relative(rootDir, filePath)}`)
    console.error(`[dev] 请先执行：${installHint}\n`)
    process.exit(1)
  }
}

const preferredBackendPort = parsePort(
  process.env.NOWEN_DEV_BACKEND_PORT ?? process.env.PORT,
  3001,
)
const preferredFrontendPort = parsePort(process.env.NOWEN_DEV_FRONTEND_PORT, 5173)

const backendPort = await findAvailablePort(preferredBackendPort)
const frontendPort = await findAvailablePort(
  preferredFrontendPort,
  new Set([backendPort]),
)

const backendUrl = `http://127.0.0.1:${backendPort}`
const frontendUrl = `http://localhost:${frontendPort}`

const electronCli = path.join(rootDir, "node_modules", "electron", "cli.js")
const tsxCli = path.join(backendDir, "node_modules", "tsx", "dist", "cli.mjs")
const backendEntry = path.join(backendDir, "src", "index.hardened.ts")
const viteCli = path.join(frontendDir, "node_modules", "vite", "bin", "vite.js")
const viteDevConfig = path.join(frontendDir, "vite.dev.config.ts")

assertFile(electronCli, "npm install")
assertFile(tsxCli, "npm run install:all")
assertFile(viteCli, "npm run install:all")
assertFile(backendEntry, "确认 backend/src/index.hardened.ts 是否存在")
assertFile(viteDevConfig, "确认 frontend/vite.dev.config.ts 是否存在")

console.log("\n🚀 Nowen Note 开发环境")
console.log(`   前端: ${frontendUrl}${frontendPort !== preferredFrontendPort ? `（${preferredFrontendPort} 已占用，已自动切换）` : ""}`)
console.log(`   后端: ${backendUrl}${backendPort !== preferredBackendPort ? `（${preferredBackendPort} 已占用，已自动切换）` : ""}`)
console.log("   按 Ctrl+C 可同时停止前后端\n")

const children = []
let stopping = false

function startProcess(label, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: "inherit",
    detached: process.platform !== "win32",
    windowsHide: false,
  })

  children.push(child)

  child.once("error", (error) => {
    console.error(`[dev] ${label} 启动失败:`, error)
    void shutdown(1)
  })

  child.once("exit", (code, signal) => {
    if (stopping) return
    const reason = signal ? `信号 ${signal}` : `退出码 ${code ?? 1}`
    console.error(`\n[dev] ${label} 已退出（${reason}），正在停止其余进程...`)
    void shutdown(code ?? 1)
  })

  return child
}

function terminateChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }

  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      })
      killer.once("error", () => resolve())
      killer.once("exit", () => resolve())
    })
  }

  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    try {
      child.kill("SIGTERM")
    } catch {
      // 进程可能已自行退出。
    }
  }

  return Promise.resolve()
}

async function shutdown(exitCode = 0) {
  if (stopping) return
  stopping = true
  await Promise.all(children.map(terminateChild))
  process.exit(exitCode)
}

process.once("SIGINT", () => void shutdown(0))
process.once("SIGTERM", () => void shutdown(0))

startProcess(
  "后端",
  process.execPath,
  [electronCli, tsxCli, "watch", backendEntry],
  {
    cwd: rootDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(backendPort),
    },
  },
)

startProcess(
  "前端",
  process.execPath,
  [
    viteCli,
    "--config",
    viteDevConfig,
    "--host",
    "0.0.0.0",
    "--port",
    String(frontendPort),
    "--strictPort",
  ],
  {
    cwd: frontendDir,
    env: {
      ...process.env,
      NOWEN_DEV_BACKEND_URL: backendUrl,
      NOWEN_DEV_BACKEND_PORT: String(backendPort),
    },
  },
)
