import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { ensureWorkspaceDependencies, inspectDependencyState } from "../dev-dependency-manager.mjs"

function createWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nowen-dev-deps-"))
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function installFakePackage(workspace, packageName, version) {
  const packageDir = path.join(workspace, "node_modules", ...packageName.split("/"))
  writeJson(path.join(packageDir, "package.json"), { name: packageName, version })
}

test("reports a newly declared dependency that is missing from node_modules", () => {
  const workspace = createWorkspace()
  writeJson(path.join(workspace, "package.json"), {
    dependencies: { "@capacitor/local-notifications": "^8.0.0" },
  })
  writeJson(path.join(workspace, "package-lock.json"), {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "@capacitor/local-notifications": "^8.0.0" } },
      "node_modules/@capacitor/local-notifications": { version: "8.0.0" },
    },
  })
  writeJson(path.join(workspace, "node_modules", ".package-lock.json"), {
    lockfileVersion: 3,
    packages: {},
  })

  const state = inspectDependencyState(workspace)
  assert.equal(state.ok, false)
  assert.deepEqual(state.missing, ["@capacitor/local-notifications"])
})

test("reports an installed direct dependency whose hidden lock version is stale", () => {
  const workspace = createWorkspace()
  writeJson(path.join(workspace, "package.json"), {
    dependencies: { "@capacitor/core": "^8.3.1" },
  })
  writeJson(path.join(workspace, "package-lock.json"), {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "@capacitor/core": "^8.3.1" } },
      "node_modules/@capacitor/core": { version: "8.3.1", integrity: "sha-new" },
    },
  })
  installFakePackage(workspace, "@capacitor/core", "8.2.0")
  writeJson(path.join(workspace, "node_modules", ".package-lock.json"), {
    lockfileVersion: 3,
    packages: {
      "node_modules/@capacitor/core": { version: "8.2.0", integrity: "sha-old" },
    },
  })

  const state = inspectDependencyState(workspace)
  assert.equal(state.ok, false)
  assert.deepEqual(state.stale, ["@capacitor/core"])
})

test("accepts a synchronized workspace", () => {
  const workspace = createWorkspace()
  writeJson(path.join(workspace, "package.json"), {
    dependencies: { vite: "^5.4.10" },
  })
  writeJson(path.join(workspace, "package-lock.json"), {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { vite: "^5.4.10" } },
      "node_modules/vite": { version: "5.4.21", integrity: "sha-vite" },
    },
  })
  installFakePackage(workspace, "vite", "5.4.21")
  writeJson(path.join(workspace, "node_modules", ".package-lock.json"), {
    lockfileVersion: 3,
    packages: {
      "node_modules/vite": { version: "5.4.21", integrity: "sha-vite" },
    },
  })

  const state = inspectDependencyState(workspace)
  assert.equal(state.ok, true)
  assert.deepEqual(state.missing, [])
  assert.deepEqual(state.stale, [])
})

test("automatically installs a missing local dependency in a workspace with spaces", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nowen dev deps "))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const previousAutoInstall = process.env.NOWEN_DEV_AUTO_INSTALL
  delete process.env.NOWEN_DEV_AUTO_INSTALL
  t.after(() => {
    if (previousAutoInstall === undefined) delete process.env.NOWEN_DEV_AUTO_INSTALL
    else process.env.NOWEN_DEV_AUTO_INSTALL = previousAutoInstall
  })

  writeJson(path.join(workspace, "fixture-package", "package.json"), {
    name: "nowen-dev-dependency-fixture",
    version: "1.0.0",
  })
  writeJson(path.join(workspace, "package.json"), {
    name: "nowen-dev-dependency-test",
    version: "1.0.0",
    private: true,
    dependencies: { "nowen-dev-dependency-fixture": "file:./fixture-package" },
  })

  assert.equal(inspectDependencyState(workspace).ok, false)
  const result = ensureWorkspaceDependencies(workspace, "测试")
  assert.equal(result.installed, true)
  assert.equal(result.state.ok, true)
  assert.equal(ensureWorkspaceDependencies(workspace, "测试").installed, false)
})
