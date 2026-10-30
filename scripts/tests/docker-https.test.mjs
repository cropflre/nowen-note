import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import test, { after } from "node:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const projectDir = mkdtempSync(path.join(os.tmpdir(), "nowen-https-compose-"))
writeFileSync(path.join(projectDir, ".env"), "")
after(() => {
  assert.equal(path.dirname(projectDir), path.resolve(os.tmpdir()))
  assert.ok(path.basename(projectDir).startsWith("nowen-https-compose-"))
  rmSync(projectDir, { recursive: true, force: true })
})

function composeConfig({ https = true, domain = "note.example.com", updater = false } = {}) {
  const args = [
    "--project-directory", projectDir, "--project-name", "nowen-https-test",
    "--env-file", path.join(projectDir, ".env"),
    "-f", path.join(rootDir, "docker-compose.yml"),
  ]
  if (https) args.push("-f", path.join(rootDir, "docker-compose.https.yml"))
  if (updater) args.push("--profile", "updater")
  args.push("config", "--format", "json")
  const env = {
    ...process.env, COMPOSE_FILE: "", COMPOSE_PROFILES: "",
    NOWEN_DOMAIN: domain, NOWEN_PORT: "43210", NOWEN_IMAGE_TAG: "v1.5.1",
    PUBLIC_WEB_ORIGIN: "http://old.example.com", FILE_PUBLIC_ORIGIN: "",
    NOWEN_UPDATER_TOKEN: "https-test-token-00000000000000000000",
  }
  const binary = process.env.NOWEN_TEST_COMPOSE_BIN || "docker"
  return spawnSync(binary, process.env.NOWEN_TEST_COMPOSE_BIN ? args : ["compose", ...args], {
    encoding: "utf8", env,
  })
}

function readConfig(options) {
  const result = composeConfig(options)
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test("HTTPS merge removes host HTTP access and sets the HTTPS public origin", () => {
  const config = readConfig()
  const app = config.services["nowen-note"]
  assert.equal(app.ports?.length || 0, 0)
  assert.equal(app.environment.PUBLIC_WEB_ORIGIN, "https://note.example.com")
  assert.equal(app.environment.PORT, "3001")
  assert.equal(app.volumes.find((volume) => volume.target === "/app/data").source, "nowen-note-data")
  assert.match(app.healthcheck.test.at(-1), /http:\/\/127\.0\.0\.1:/)

  const caddy = config.services.caddy
  assert.deepEqual(caddy.ports.map(({ target, published, protocol }) => [target, published, protocol]), [
    [80, "80", "tcp"], [443, "443", "tcp"], [443, "443", "udp"],
  ])
  assert.equal(caddy.environment.NOWEN_DOMAIN, "note.example.com")
  assert.equal(caddy.volumes.find((volume) => volume.target === "/etc/caddy/Caddyfile").read_only, true)
  assert.equal(caddy.volumes.find((volume) => volume.target === "/data").type, "volume")
  assert.equal(caddy.volumes.find((volume) => volume.target === "/config").type, "volume")
  assert.deepEqual(Object.keys(caddy.networks), ["nowen-network"])
  assert.equal(caddy.volumes.some((volume) => volume.target === "/var/run/docker.sock"), false)
})

test("HTTPS preserves the data volume and updater isolation", () => {
  const base = readConfig({ https: false, updater: true })
  const config = readConfig({ updater: true })
  assert.deepEqual(config.volumes["nowen-note-data"], base.volumes["nowen-note-data"])
  assert.deepEqual(config.services["nowen-note"].volumes, base.services["nowen-note"].volumes)
  assert.deepEqual(config.services["nowen-note-updater"], base.services["nowen-note-updater"])
  assert.equal(config.services["nowen-note-updater"].ports?.length || 0, 0)
  assert.equal(config.networks["nowen-update-internal"].internal, true)
})

test("HTTPS refuses an empty domain before starting any containers", () => {
  const result = composeConfig({ domain: "" })
  assert.ifError(result.error)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /NOWEN_DOMAIN/)
})

test("base HTTP deployment still works without a domain or Caddy", () => {
  const config = readConfig({ https: false, domain: "" })
  assert.equal(config.services.caddy, undefined)
  assert.equal(config.services["nowen-note"].ports[0].published, "43210")
})
