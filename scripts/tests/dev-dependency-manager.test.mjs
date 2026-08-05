import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { inspectDependencyState } from "../dev-dependency-manager.mjs"

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
