#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import archiver from "archiver";

const command = process.argv[2] || "doctor";
const commandArgs = process.argv.slice(3);
const cwd = process.cwd();
const manifestPath = path.join(cwd, "manifest.json");
const knownPermissions = new Set([
  "notes:read", "notes:write", "notebooks:read", "notebooks:write", "tags:read", "tags:write",
  "tasks:read", "tasks:write", "attachments:read", "attachments:write", "diary:read", "diary:write",
  "mindmaps:read", "mindmaps:write", "plugin-storage:read", "plugin-storage:write", "external:fetch", "secrets:use",
]);

function fail(message) { throw new Error(message); }
function readManifest() {
  if (!fs.existsSync(manifestPath)) fail("manifest.json not found");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(manifest.id || "")) fail("invalid plugin id");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version || "")) fail("invalid version");
  if (![1, 2].includes(manifest.apiVersion)) fail("unsupported apiVersion");
  if (manifest.apiVersion === 1 && manifest.runtime !== "node-action") fail("V1 requires node-action");
  if (manifest.apiVersion === 2 && !["sandbox-js", "node-action"].includes(manifest.runtime)) fail("invalid V2 runtime");
  if (manifest.apiVersion === 2 && (!manifest.publisher || !manifest.id.startsWith(`${manifest.publisher}.`) || !manifest.repository || !manifest.license || !Array.isArray(manifest.categories))) fail("V2 publisher namespace, repository, license and categories are required");
  if (!manifest.engines?.nowen || !manifest.main) fail("engines.nowen and main are required");
  const normalizedMain = String(manifest.main).replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalizedMain) || normalizedMain.split("/").includes("..")) fail("main escapes plugin root");
  if (!Array.isArray(manifest.actions) || manifest.actions.length === 0) fail("at least one action is required");
  const actionIds = manifest.actions.map((item) => item.id);
  if (new Set(actionIds).size !== actionIds.length) fail("duplicate action id");
  if ((manifest.permissions || []).some((permission) => !knownPermissions.has(permission))) fail("unknown permission");
  return manifest;
}

function validate(requireMain = true) {
  const manifest = readManifest();
  if (requireMain && !fs.existsSync(path.resolve(cwd, manifest.main))) fail(`main not found: ${manifest.main}`);
  process.stdout.write(`valid ${manifest.id}@${manifest.version}\n`);
  return manifest;
}

async function doctor() {
  const manifest = validate(true);
  if (manifest.runtime === "sandbox-js") {
    const { getQuickJS } = await import("quickjs-emscripten");
    const QuickJS = await getQuickJS(); const runtime = QuickJS.newRuntime(); runtime.setMemoryLimit(64 * 1024 * 1024); const vm = runtime.newContext();
    try {
      const result = vm.evalCode(`${fs.readFileSync(path.resolve(cwd, manifest.main), "utf8")}\n;Boolean(globalThis.__nowenPluginModule)`);
      const handle = vm.unwrapResult(result); const loaded = vm.dump(handle); handle.dispose(); if (!loaded) fail("sandbox bundle must define globalThis.__nowenPluginModule");
    } finally { vm.dispose(); runtime.dispose(); }
    process.stdout.write(`doctor ok (${manifest.actions.length} sandbox actions)\n`); return;
  }
  const module = await import(`${pathToFileURL(path.resolve(cwd, manifest.main)).href}?doctor=${Date.now()}`);
  const plugin = module.default || module;
  const missing = manifest.actions.filter((action) => typeof plugin.actions?.[action.id] !== "function").map((action) => action.id);
  if (missing.length) fail(`actions missing at runtime: ${missing.join(", ")}`);
  const warnings = [];
  if (!fs.existsSync(path.join(cwd, "README.md"))) warnings.push("README.md missing");
  if (!manifest.license) warnings.push("manifest license missing");
  for (const warning of warnings) process.stdout.write(`warning: ${warning}\n`);
  process.stdout.write(`doctor ok (${manifest.actions.length} actions)\n`);
}

function build() {
  const manifest = validate(false);
  const source = fs.existsSync(path.join(cwd, "src", "index.ts")) ? "src/index.ts" : "src/index.js";
  if (!fs.existsSync(path.join(cwd, source))) fail("src/index.ts or src/index.js not found");
  fs.mkdirSync(path.dirname(path.resolve(cwd, manifest.main)), { recursive: true });
  const arguments_ = manifest.runtime === "sandbox-js"
    ? [source, "--bundle", "--platform=browser", "--format=iife", "--global-name=__nowenPluginModule", "--footer:js=globalThis.__nowenPluginModule=__nowenPluginModule;", `--outfile=${manifest.main}`]
    : [source, "--bundle", "--platform=node", "--format=esm", `--outfile=${manifest.main}`];
  const localEsbuild = path.join(cwd, "node_modules", "esbuild", "bin", "esbuild");
  const result = fs.existsSync(localEsbuild)
    ? spawnSync(process.execPath, [localEsbuild, ...arguments_], { cwd, stdio: "inherit" })
    : spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["esbuild", ...arguments_], { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) fail(`build failed: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status || 1);
}

async function pack() {
  const manifest = validate(true);
  const outputDir = path.join(cwd, "dist");
  fs.mkdirSync(outputDir, { recursive: true });
  const base = `${manifest.id}-${manifest.version}`;
  const outputPath = path.join(outputDir, `${base}.nowen-plugin`);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve); output.on("error", reject); archive.on("error", reject); archive.pipe(output);
    archive.file(manifestPath, { name: "manifest.json" });
    archive.file(path.resolve(cwd, manifest.main), { name: manifest.main.replace(/\\/g, "/") });
    for (const optional of ["README.md", manifest.icon, ...(manifest.screenshots || []), ...(manifest.contributes?.automationTemplates || []).map((item) => item.file)].filter(Boolean)) {
      const absolute = path.resolve(cwd, optional);
      if (fs.existsSync(absolute)) archive.file(absolute, { name: String(optional).replace(/\\/g, "/") });
    }
    void archive.finalize();
  });
  const digest = crypto.createHash("sha256").update(fs.readFileSync(outputPath)).digest("hex");
  fs.writeFileSync(`${outputPath}.sha256`, `${digest}  ${path.basename(outputPath)}\n`);
  process.stdout.write(`${outputPath}\n${outputPath}.sha256\n`);
}

function option(name, fallback) { const index = commandArgs.indexOf(`--${name}`); return index >= 0 ? commandArgs[index + 1] : fallback; }
function artifactPath(manifest) { return path.join(cwd, "dist", `${manifest.id}-${manifest.version}.nowen-plugin`); }

async function sign() {
  const manifest = validate(true); const artifact = artifactPath(manifest); if (!fs.existsSync(artifact)) await pack();
  const keyPath = option("key", process.env.NOWEN_PUBLISHER_KEY); const keyId = option("key-id", process.env.NOWEN_PUBLISHER_KEY_ID);
  if (!keyPath || !keyId) fail("sign requires --key and --key-id");
  const bytes = fs.readFileSync(artifact); const digest = crypto.createHash("sha256").update(bytes).digest();
  const signature = crypto.sign(null, digest, fs.readFileSync(path.resolve(cwd, keyPath), "utf8")).toString("base64");
  const output = `${artifact}.sig.json`; fs.writeFileSync(output, `${JSON.stringify({ algorithm: "Ed25519", keyId, sha256: digest.toString("hex"), signature }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${output}\n`);
}

function login() {
  const token = option("token", process.env.NOWEN_REGISTRY_TOKEN); const registry = option("registry", process.env.NOWEN_REGISTRY_URL);
  if (!token || !registry || !/^https:\/\//.test(registry)) fail("login requires --registry https://... --token ...");
  const configDir = path.join(process.env.USERPROFILE || process.env.HOME || cwd, ".nowen"); fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "plugin-cli.json"), JSON.stringify({ registry, token }), { mode: 0o600 }); process.stdout.write("login saved\n");
}

async function publish() {
  const manifest = validate(true); const artifact = artifactPath(manifest); const sig = `${artifact}.sig.json`;
  if (!fs.existsSync(artifact)) await pack(); if (!fs.existsSync(sig)) await sign();
  const configPath = path.join(process.env.USERPROFILE || process.env.HOME || cwd, ".nowen", "plugin-cli.json");
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  const registry = option("registry", process.env.NOWEN_REGISTRY_URL || config.registry); const token = process.env.NOWEN_REGISTRY_TOKEN || config.token;
  if (!registry || !token) fail("run login or set NOWEN_REGISTRY_URL/NOWEN_REGISTRY_TOKEN");
  const form = new FormData(); form.set("manifest", JSON.stringify(manifest)); form.set("signature", fs.readFileSync(sig, "utf8")); form.set("artifact", new Blob([fs.readFileSync(artifact)]), path.basename(artifact));
  const response = await fetch(new URL("/v2/publish", registry), { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  if (!response.ok) fail(`publish failed: HTTP ${response.status} ${await response.text()}`); process.stdout.write(`${await response.text()}\n`);
}

function create() {
  const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["create-nowen-plugin", ...commandArgs], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status) process.exit(result.status);
}

try {
  if (command === "--help" || command === "-h" || command === "help") process.stdout.write("usage: nowen-plugin <create|dev|validate|build|test|pack|sign|login|publish|doctor>\n");
  else if (command === "create") create();
  else if (command === "validate") validate(true);
  else if (command === "build") build();
  else if (command === "dev") { build(); process.stdout.write("dev build complete; rerun after source changes\n"); }
  else if (command === "test") { build(); await doctor(); }
  else if (command === "pack") await pack();
  else if (command === "sign") await sign();
  else if (command === "login") login();
  else if (command === "publish") await publish();
  else if (command === "doctor") await doctor();
  else fail("usage: nowen-plugin <create|dev|validate|build|test|pack|sign|login|publish|doctor>");
} catch (error) {
  process.stderr.write(`nowen-plugin: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
