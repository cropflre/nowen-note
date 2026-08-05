import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const rootDir = path.resolve(path.dirname(__filename), "../..")

async function readRepoFile(relativePath) {
  return readFile(path.join(rootDir, relativePath), "utf8")
}

function extractMainHealthcheck(source) {
  const marker = "fetch('http://127.0.0.1:'"
  const index = source.indexOf(marker)
  assert.notEqual(index, -1, "未找到主服务动态健康检查")
  return source.slice(Math.max(0, index - 160), index + 260)
}

test("Docker image healthcheck uses the runtime PORT instead of fixed 3001", async () => {
  const dockerfile = await readRepoFile("Dockerfile")
  const healthcheck = extractMainHealthcheck(dockerfile)

  assert.match(healthcheck, /process\.env\.PORT\s*\|\|\s*['"]3001['"]/)
  assert.doesNotMatch(healthcheck, /127\.0\.0\.1:3001\/api\/health/)
})

test("Docker Compose healthcheck uses the runtime PORT instead of fixed 3001", async () => {
  const compose = await readRepoFile("docker-compose.yml")
  const healthcheck = extractMainHealthcheck(compose)

  assert.match(healthcheck, /process\.env\.PORT\s*\|\|\s*['"]3001['"]/)
  assert.doesNotMatch(healthcheck, /127\.0\.0\.1:3001\/api\/health/)
})
