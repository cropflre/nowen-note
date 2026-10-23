import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { resolveConfig } from "../../frontend/node_modules/vite/dist/node/index.js"

const rootDir = fileURLToPath(new URL("../../", import.meta.url))
const configFile = path.join(rootDir, "frontend/vite.dev.config.ts")

test("development config preserves base aliases, React plugins and build settings", async () => {
  const config = await resolveConfig({ configFile }, "serve")
  const base = await resolveConfig({ configFile: path.join(rootDir, "frontend/vite.config.ts") }, "serve")
  const resolve = config.createResolver()

  for (const name of ["toast", "api", "deviceId", "codeBlockPermissions", "editorPerformanceProtocol", "serverUrl"]) {
    assert.equal(await resolve(`@/lib/${name}`), path.join(rootDir, `frontend/src/lib/${name}.ts`).replaceAll("\\", "/"))
  }
  assert.deepEqual(config.resolve.alias, base.resolve.alias)
  assert.deepEqual(config.plugins.map(plugin => plugin.name), base.plugins.map(plugin => plugin.name))
  assert.deepEqual(config.define, base.define)
  assert.deepEqual(config.build.target, base.build.target)
})

test("development config passes mode to base config and preserves backend proxy overrides", async () => {
  const previousUrl = process.env.NOWEN_DEV_BACKEND_URL
  try {
    delete process.env.NOWEN_DEV_BACKEND_URL
    const defaults = await resolveConfig({ configFile }, "serve")
    assert.equal(defaults.server.proxy["/api"].target, "http://127.0.0.1:3001")
    assert.equal(defaults.server.proxy["/ws"].target, "ws://127.0.0.1:3001")

    process.env.NOWEN_DEV_BACKEND_URL = " https://127.0.0.1:4002 "
    const config = await resolveConfig({ configFile, mode: "harmony" }, "serve")
    assert.equal(config.server.proxy["/api"].target, "https://127.0.0.1:4002")
    assert.equal(config.server.proxy["/ws"].target, "wss://127.0.0.1:4002")
    assert.equal(config.server.proxy["/ws"].ws, true)
    assert.equal(await config.createResolver()("@aparajita/capacitor-secure-storage"), path.join(rootDir, "frontend/src/lib/harmonySecureStorage.ts").replaceAll("\\", "/"))
  } finally {
    if (previousUrl === undefined) delete process.env.NOWEN_DEV_BACKEND_URL
    else process.env.NOWEN_DEV_BACKEND_URL = previousUrl
  }
})
