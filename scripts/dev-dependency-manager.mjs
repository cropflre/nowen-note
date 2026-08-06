import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function dependencyPackagePath(workspaceDir, packageName) {
  return path.join(workspaceDir, "node_modules", ...packageName.split("/"), "package.json")
}

function lockPackageKey(packageName) {
  return `node_modules/${packageName}`
}

export function inspectDependencyState(workspaceDir) {
  const manifestPath = path.join(workspaceDir, "package.json")
  const manifest = readJson(manifestPath)
  if (!manifest) {
    return {
      ok: false,
      reason: `无法读取 ${manifestPath}`,
      missing: [],
      stale: [],
    }
  }

  const directDependencies = {
    ...(manifest.dependencies || {}),
    ...(manifest.devDependencies || {}),
    ...(manifest.optionalDependencies || {}),
  }
  const packageNames = Object.keys(directDependencies).sort()
  const missing = packageNames.filter(
    (packageName) => !fs.existsSync(dependencyPackagePath(workspaceDir, packageName)),
  )

  const expectedLock = readJson(path.join(workspaceDir, "package-lock.json"))
  const installedLock = readJson(path.join(workspaceDir, "node_modules", ".package-lock.json"))
  const stale = []

  if (expectedLock?.packages && installedLock?.packages) {
    for (const packageName of packageNames) {
      const key = lockPackageKey(packageName)
      const expected = expectedLock.packages[key]
      const installed = installedLock.packages[key]
      if (!expected || !installed) {
        if (expected && !installed && !missing.includes(packageName)) stale.push(packageName)
        continue
      }
      if (
        expected.version !== installed.version ||
        (expected.integrity && installed.integrity && expected.integrity !== installed.integrity)
      ) {
        stale.push(packageName)
      }
    }
  }

  return {
    ok: missing.length === 0 && stale.length === 0,
    reason: "",
    missing,
    stale: [...new Set(stale)].sort(),
  }
}

function formatDependencyList(state) {
  const parts = []
  if (state.missing.length > 0) parts.push(`缺失：${state.missing.join(", ")}`)
  if (state.stale.length > 0) parts.push(`版本未同步：${state.stale.join(", ")}`)
  return parts.join("；")
}

export function ensureWorkspaceDependencies(workspaceDir, label) {
  const initial = inspectDependencyState(workspaceDir)
  if (initial.ok) return { installed: false, state: initial }
  if (initial.reason) throw new Error(initial.reason)

  const installCommand = process.platform === "win32" ? "npm.cmd" : "npm"
  const installHint = `cd ${JSON.stringify(workspaceDir)} && npm install`
  if (process.env.NOWEN_DEV_AUTO_INSTALL === "0") {
    throw new Error(
      `${label}依赖未同步（${formatDependencyList(initial)}）。请执行：${installHint}`,
    )
  }

  console.log(`\n[dev] 检测到${label}依赖未同步：${formatDependencyList(initial)}`)
  console.log(`[dev] 正在自动执行 npm install：${workspaceDir}`)
  const result = spawnSync(installCommand, ["install", "--no-audit", "--no-fund"], {
    cwd: workspaceDir,
    stdio: "inherit",
    windowsHide: false,
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label}依赖安装失败${result.error ? `：${result.error.message}` : `（退出码 ${result.status}）`}。请手动执行：${installHint}`,
    )
  }

  const finalState = inspectDependencyState(workspaceDir)
  if (!finalState.ok) {
    throw new Error(
      `${label}依赖安装后仍未同步（${formatDependencyList(finalState)}）。请删除该目录下的 node_modules 后重新执行 npm install。`,
    )
  }

  console.log(`[dev] ${label}依赖已同步完成。`)
  return { installed: true, state: finalState }
}
