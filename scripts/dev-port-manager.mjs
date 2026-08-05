import path from "node:path"
import process from "node:process"
import net from "node:net"
import { spawn } from "node:child_process"
import { readFile, readdir, readlink } from "node:fs/promises"

const DEFAULT_RELEASE_TIMEOUT_MS = 8_000
const RETRY_INTERVAL_MS = 160
const protectedPids = new Set([process.pid, process.ppid].filter((pid) => Number.isInteger(pid) && pid > 0))

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function uniquePids(values) {
  return [...new Set(values
    .map((value) => Number.parseInt(String(value), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0))]
}

function parsePids(value) {
  return uniquePids(String(value || "").match(/\d+/g) || [])
}

function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    let settled = false
    let stdout = ""
    let stderr = ""
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => { stdout += chunk })
    child.stderr?.on("data", (chunk) => { stderr += chunk })

    const finish = (result) => {
      if (settled) return
      settled = true
      resolve({ stdout, stderr, ...result })
    }

    child.once("error", (error) => finish({ code: null, error }))
    child.once("close", (code, signal) => finish({ code, signal, error: null }))
  })
}

export function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    let settled = false

    const finish = (available) => {
      if (settled) return
      settled = true
      resolve(available)
    }

    server.unref()
    server.once("error", () => finish(false))
    server.listen({ port, host: "0.0.0.0", exclusive: true }, () => {
      server.close(() => finish(true))
    })
  })
}

async function waitForPortAvailable(port, timeoutMs = DEFAULT_RELEASE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  do {
    if (await isPortAvailable(port)) return true
    await delay(RETRY_INTERVAL_MS)
  } while (Date.now() < deadline)
  return isPortAvailable(port)
}

function addressUsesPort(address, port) {
  const separator = String(address || "").lastIndexOf(":")
  if (separator < 0) return false
  return Number.parseInt(address.slice(separator + 1), 10) === port
}

async function findWindowsListeningPids(port) {
  const pids = new Set()
  const powershellCandidates = []

  if (process.env.SystemRoot) {
    powershellCandidates.push(path.win32.join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ))
  }
  powershellCandidates.push("powershell.exe", "powershell")

  const command = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$items=Get-NetTCPConnection -LocalPort ${port} -State Listen`,
    "if($items){$items | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique}",
  ].join("; ")

  for (const powershell of powershellCandidates) {
    const result = await runCommand(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ])
    if (result.error) continue
    for (const pid of parsePids(result.stdout)) pids.add(pid)
    if (pids.size > 0) return [...pids]
    if (result.code === 0) break
  }

  const netstat = await runCommand("netstat", ["-ano", "-p", "tcp"])
  if (!netstat.error) {
    for (const rawLine of netstat.stdout.split(/\r?\n/)) {
      const parts = rawLine.trim().split(/\s+/)
      if (parts.length < 5 || parts[0]?.toUpperCase() !== "TCP") continue
      if (!addressUsesPort(parts[1], port)) continue
      const state = String(parts.at(-2) || "").toUpperCase()
      if (!state.includes("LISTEN") && !state.includes("侦听")) continue
      const pid = Number.parseInt(parts.at(-1), 10)
      if (Number.isInteger(pid) && pid > 0) pids.add(pid)
    }
  }

  return [...pids]
}

async function findLinuxSocketInodes(port) {
  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0")
  const inodes = new Set()

  for (const filename of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let content = ""
    try {
      content = await readFile(filename, "utf8")
    } catch {
      continue
    }

    for (const rawLine of content.split("\n").slice(1)) {
      const columns = rawLine.trim().split(/\s+/)
      if (columns.length < 10) continue
      const localAddress = columns[1] || ""
      const state = columns[3] || ""
      const localPort = localAddress.split(":").at(-1)?.toUpperCase()
      if (state !== "0A" || localPort !== expectedPort) continue
      const inode = columns[9]
      if (inode && inode !== "0") inodes.add(inode)
    }
  }

  return inodes
}

async function findLinuxPidsBySocketInodes(inodes) {
  if (inodes.size === 0) return []
  const pids = new Set()
  let procEntries = []

  try {
    procEntries = await readdir("/proc", { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const pid = Number.parseInt(entry.name, 10)
    if (!Number.isInteger(pid) || protectedPids.has(pid)) continue

    let descriptors = []
    try {
      descriptors = await readdir(`/proc/${pid}/fd`)
    } catch {
      continue
    }

    for (const descriptor of descriptors) {
      let target = ""
      try {
        target = await readlink(`/proc/${pid}/fd/${descriptor}`)
      } catch {
        continue
      }
      const match = /^socket:\[(\d+)\]$/.exec(target)
      if (match && inodes.has(match[1])) {
        pids.add(pid)
        break
      }
    }
  }

  return [...pids]
}

async function findUnixListeningPids(port) {
  const pids = new Set()

  const lsof = await runCommand("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ])
  if (!lsof.error) {
    for (const pid of parsePids(lsof.stdout)) pids.add(pid)
  }

  // GNU fuser writes only PIDs to stdout. Never parse stderr here: error messages may
  // contain the port number and must not be mistaken for a process id.
  const fuser = await runCommand("fuser", ["-n", "tcp", String(port)])
  if (!fuser.error) {
    for (const pid of parsePids(fuser.stdout)) pids.add(pid)
  }

  const ss = await runCommand("ss", ["-ltnp", `sport = :${port}`])
  if (!ss.error) {
    const matches = [...`${ss.stdout}\n${ss.stderr}`.matchAll(/pid=(\d+)/g)]
    for (const match of matches) pids.add(Number.parseInt(match[1], 10))
  }

  if (process.platform === "linux" && pids.size === 0) {
    const inodes = await findLinuxSocketInodes(port)
    for (const pid of await findLinuxPidsBySocketInodes(inodes)) pids.add(pid)
  }

  return uniquePids([...pids])
}

export async function findListeningPids(port) {
  const pids = process.platform === "win32"
    ? await findWindowsListeningPids(port)
    : await findUnixListeningPids(port)
  return pids.filter((pid) => !protectedPids.has(pid))
}

async function readUnixProcessTable() {
  const result = await runCommand("ps", ["-eo", "pid=,ppid=,comm="])
  if (result.error || result.code !== 0) return []

  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) return []
    return [{
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      command: match[3].trim(),
    }]
  })
}

async function describeProcess(pid) {
  if (process.platform === "win32") {
    const result = await runCommand("tasklist", [
      "/FI",
      `PID eq ${pid}`,
      "/FO",
      "CSV",
      "/NH",
    ])
    const match = result.stdout.trim().match(/^"([^"]+)"/)
    return match?.[1] || "未知进程"
  }

  const result = await runCommand("ps", ["-p", String(pid), "-o", "comm="])
  return result.stdout.trim() || "未知进程"
}

function collectDescendants(rootPid, processTable) {
  const childrenByParent = new Map()
  for (const item of processTable) {
    const children = childrenByParent.get(item.ppid) || []
    children.push(item.pid)
    childrenByParent.set(item.ppid, children)
  }

  const descendants = []
  const queue = [{ pid: rootPid, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const childPid of childrenByParent.get(current.pid) || []) {
      descendants.push({ pid: childPid, depth: current.depth + 1 })
      queue.push({ pid: childPid, depth: current.depth + 1 })
    }
  }

  return descendants
    .sort((left, right) => right.depth - left.depth)
    .map((item) => item.pid)
}

async function killWindowsProcessTree(pid) {
  if (pid <= 4) {
    throw new Error(`拒绝终止 Windows 系统进程 PID ${pid}`)
  }
  await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"])
}

async function killUnixProcessTree(pid) {
  const processTable = await readUnixProcessTable()
  const descendants = collectDescendants(pid, processTable)

  for (const targetPid of [...descendants, pid]) {
    if (protectedPids.has(targetPid)) continue
    try {
      process.kill(targetPid, "SIGKILL")
    } catch (error) {
      if (error?.code !== "ESRCH") throw error
    }
  }
}

async function killProcessTree(pid) {
  if (protectedPids.has(pid)) {
    throw new Error(`拒绝终止当前开发启动器相关进程 PID ${pid}`)
  }
  if (process.platform === "win32") {
    await killWindowsProcessTree(pid)
  } else {
    await killUnixProcessTree(pid)
  }
}

export async function forceReleasePort(port, label = "开发服务", options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_RELEASE_TIMEOUT_MS
  const log = options.log || console.log

  if (await isPortAvailable(port)) return { port, killedPids: [] }

  const killedPids = new Set()
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const pids = await findListeningPids(port)
    if (pids.length === 0) {
      if (await waitForPortAvailable(port, Math.min(timeoutMs, 1_000))) {
        return { port, killedPids: [...killedPids] }
      }
      throw new Error(
        `${label}端口 ${port} 已被占用，但无法识别监听进程。请使用管理员权限重新运行。`,
      )
    }

    for (const pid of pids) {
      const processName = await describeProcess(pid)
      log(`[dev] ${label}端口 ${port} 被 ${processName}（PID ${pid}）占用，正在强制停止进程树...`)
      await killProcessTree(pid)
      killedPids.add(pid)
    }

    if (await waitForPortAvailable(port, timeoutMs)) {
      log(`[dev] ✓ ${label}端口 ${port} 已释放`)
      return { port, killedPids: [...killedPids] }
    }
  }

  throw new Error(`${label}端口 ${port} 在强制停止占用进程后仍未释放`)
}

export async function forceReleasePorts(entries, options = {}) {
  const seen = new Set()
  const results = []

  for (const entry of entries) {
    if (seen.has(entry.port)) continue
    seen.add(entry.port)
    results.push(await forceReleasePort(entry.port, entry.label, options))
  }

  return results
}
