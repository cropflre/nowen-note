// GitHub-hosted publisher. Desktop collection reuses the existing tag/SHA gates.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assetSnapshot, collectRelease, REPO, validateSource } from "./release-ci-assets.mjs";
const { requiredMacReleaseAssets, requiredDebugReleaseAssets } = createRequire(import.meta.url)("./lib/release-platform-assets.cjs");

export function identity(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, REPO, "wrong release repository");
  assert.match(env.GITHUB_REF || "", /^refs\/tags\/v\d+\.\d+\.\d+$/, "select a stable version Tag in Run workflow");
  assert.match(env.GITHUB_SHA || "", /^[a-f0-9]{40}$/, "invalid source SHA");
  for (const name of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"])
    assert.match(env[name] || "", /^[1-9]\d*$/, `invalid ${name}`);
  return { tag: env.GITHUB_REF.slice(10), sha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT) };
}

function command(executable, args, capture = true) {
  const result = spawnSync(executable, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    timeout: 90 * 60_000, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  assert.ok(!result.error && result.status === 0, `${executable} ${args[0]} failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout?.trim();
}
const gh = (args) => command("gh", args);
const api = (endpoint) => JSON.parse(gh(["api", `repos/${REPO}/${endpoint}`]));
const root = fileURLToPath(new URL("../", import.meta.url));
const version = (source) => source.tag.slice(1);

function assertTag(source) {
  let object = api(`git/ref/tags/${source.tag}`).object;
  for (let depth = 0; object.type === "tag" && depth < 5; depth++) object = api(`git/tags/${object.sha}`).object;
  assert.equal(object.type, "commit");
  assert.equal(object.sha, source.sha, "remote tag moved");
}

function readRelease(source) {
  const query = 'query($tag:String!){repository(owner:"cropflre",name:"nowen-note"){release(tagName:$tag){databaseId}}}';
  const result = JSON.parse(gh(["api", "graphql", "-f", `query=${query}`, "-f", `tag=${source.tag}`]));
  assert.ok(!result.errors, "cannot read Release");
  const release = result.data.repository.release;
  return release ? api(`releases/${release.databaseId}`) : null;
}

function expectedNames(kind, source, names) {
  const v = version(source);
  if (kind === "android") return [`Nowen-Note-${v}.apk`];
  if (kind === "packages") {
    const clipper = JSON.parse(fs.readFileSync(path.join(root, "packages/nowen-clipper/package.json"))).version;
    return [`nowen-note-${v}.fpk`, `nowen-clipper-${clipper}.zip`];
  }
  if (/^docker-(amd64|arm64)$/.test(kind)) return [`image-${kind.slice(7)}.tar`];
  assert.equal(kind, "upk", "unknown artifact kind");
  assert.equal(names.length, 2, "both UPK architectures are required");
  for (const arch of ["amd64", "arm64"])
    assert.equal(names.filter(name => name.startsWith(`${arch}_`) && name.includes(`_${v}.`) && name.endsWith(".upk")).length, 1, `missing ${arch} UPK`);
  return names;
}

function hash(file) {
  const hasher = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hasher.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  return `sha256:${hasher.digest("hex")}`;
}

function filesIn(directory, kind, source) {
  const names = fs.readdirSync(directory).filter(name => name !== "evidence.json").sort();
  assert.deepEqual(names, expectedNames(kind, source, names).sort(), `unexpected ${kind} files`);
  return names.map(name => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, `invalid artifact: ${name}`);
    return { name, size: stat.size, digest: hash(file) };
  });
}

export function stageFiles(directory, kind, source) {
  const evidence = { schema: 1, ...source, kind, files: filesIn(directory, kind, source) };
  fs.writeFileSync(path.join(directory, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  return evidence;
}

export function verifyFiles(directory, kind, source) {
  const evidence = JSON.parse(fs.readFileSync(path.join(directory, "evidence.json")));
  assert.equal(evidence.schema, 1);
  for (const key of ["tag", "sha", "runId"]) assert.equal(evidence[key], source[key], `artifact ${key} mismatch`);
  assert.equal(evidence.kind, kind);
  assert.ok(Number.isSafeInteger(evidence.attempt) && evidence.attempt > 0 && evidence.attempt <= source.attempt, "invalid artifact attempt");
  const files = filesIn(directory, kind, source);
  assert.deepEqual(files, evidence.files, "artifact bytes changed");
  return files.map(file => ({ ...file, path: path.join(directory, file.name) }));
}

export function assertFullInventory(assets, source, additionalNames) {
  const v = version(source);
  const required = [...additionalNames, ...requiredMacReleaseAssets(v), ...requiredDebugReleaseAssets("linux", v),
    ...["Nowen-Note", "Nowen-Note-Lite"].flatMap(prefix => [`${prefix}-${v}-setup.exe`, `${prefix}-${v}-portable.exe`, `${prefix}-${v}-setup.exe.blockmap`]),
    "latest.yml", "latest-lite.yml"];
  const allowed = new Set([...required, ...required.filter(name => /\.(dmg|zip|AppImage)$/.test(name)).map(name => name + ".blockmap")]);
  for (const name of required) assert.ok(assets.some(asset => asset.name === name), `missing Release asset: ${name}`);
  for (const asset of assets) assert.ok(allowed.has(asset.name), `unexpected Release asset: ${asset.name}`);
}

export function assertUploadedFiles(assets, files) {
  for (const file of files) {
    const uploaded = assets.find(asset => asset.name === file.name);
    assert.equal(uploaded?.size, file.size, `uploaded size mismatch: ${file.name}`);
    assert.equal(uploaded?.digest, file.digest, `uploaded digest mismatch: ${file.name}`);
  }
}

// The same snapshot must still be present immediately before formal publication.
export async function publishRelease(source, publish, expectedAssets, deps) {
  const expected = assetSnapshot({ assets: expectedAssets });
  const check = () => {
    deps.assertTag(source);
    const current = deps.readRelease(source);
    assert.equal(current.tag_name, source.tag);
    assert.equal(current.draft, true, "refusing to replace a published Release");
    assert.deepEqual(assetSnapshot(current), expected, "Release changed after verification");
  };
  check();
  await deps.verifyRemote();
  check();
  if (!publish) return { published: false, docker: null };
  const docker = await deps.promoteDocker();
  check();
  deps.editRelease();
  return { published: true, docker };
}

async function waitDesktop(source) {
  const deadline = Date.now() + 235 * 60_000;
  while (Date.now() < deadline) {
    const runs = api(`actions/workflows/release.yml/runs?event=push&head_sha=${source.sha}&per_page=100`).workflow_runs
      .filter(run => run.head_branch === source.tag).sort((a, b) => b.id - a.id);
    const run = runs[0];
    if (run) {
      validateSource(run, { ...source, sourceRunId: String(run.id) });
      if (run.status === "completed") {
        assert.equal(run.conclusion, "success", "desktop tag build failed; rerun it before publishing");
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `source_run_id=${run.id}\n`);
        return;
      }
    }
    console.log(`[publish] waiting for desktop tag build ${source.tag}`);
    await new Promise(resolve => setTimeout(resolve, 30_000));
  }
  throw Error("desktop tag build missing or timed out; a real tag push must trigger release.yml");
}

export function prepareSigning(directory = path.join(root, "frontend/android"), env = process.env) {
  for (const name of ["NOWEN_ANDROID_KEYSTORE_B64", "NOWEN_ANDROID_KEYSTORE_PASSWORD", "NOWEN_ANDROID_KEY_ALIAS", "NOWEN_ANDROID_KEY_PASSWORD"])
    assert.ok(env[name], `missing ${name}`);
  const keystore = path.join(directory, "app/github-release.keystore");
  const properties = path.join(directory, "keystore.properties");
  // Java Properties requires escaping backslashes, leading spaces and newlines.
  const escape = value => value.split("").map(char => /[A-Za-z0-9_./-]/.test(char) ? char : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  fs.writeFileSync(keystore, Buffer.from(env.NOWEN_ANDROID_KEYSTORE_B64, "base64"), { mode: 0o600, flag: "wx" });
  fs.writeFileSync(properties, `storeFile=app/github-release.keystore\nstorePassword=${escape(env.NOWEN_ANDROID_KEYSTORE_PASSWORD)}\nkeyAlias=${escape(env.NOWEN_ANDROID_KEY_ALIAS)}\nkeyPassword=${escape(env.NOWEN_ANDROID_KEY_PASSWORD)}\n`, { mode: 0o600, flag: "wx" });
}

export function assertDockerManifest(manifest, digests) {
  assert.deepEqual(manifest.manifests?.map(item => `${item.platform.os}/${item.platform.architecture}`).sort(), ["linux/amd64", "linux/arm64"]);
  assert.deepEqual(manifest.manifests.map(item => item.digest).sort(), [...digests].sort());
}

export function registryDigest(output) {
  const { digest } = JSON.parse(output);
  assert.match(digest, /^sha256:[a-f0-9]{64}$/, "invalid registry digest");
  return digest;
}

function registryManifest(ref) {
  const result = spawnSync("docker", ["buildx", "imagetools", "inspect", ref, "--raw"], { encoding: "utf8", timeout: 120_000 });
  if (!result.error && result.status === 0) return JSON.parse(result.stdout);
  assert.ok(!result.error && /manifest unknown|not found|no such manifest/i.test(result.stderr || ""), "cannot inspect existing Docker version tag");
  return null;
}

function promoteDocker(source, incoming) {
  const repo = "cropflre/nowen-note";
  const digests = [];
  for (const arch of ["amd64", "arm64"]) {
    command("docker", ["load", "--input", path.join(incoming, `full-docker-${arch}`, `image-${arch}.tar`)], false);
    const local = `nowen-release:${source.sha}-${arch}`;
    const image = JSON.parse(command("docker", ["image", "inspect", local]))[0];
    assert.equal(image.Architecture, arch);
    assert.equal(image.Config.Labels["org.opencontainers.image.revision"], source.sha);
    assert.equal(image.Config.Labels["org.opencontainers.image.version"], source.tag);
    const staging = `${repo}:gh-${source.runId}-${source.attempt}-${arch}`;
    command("docker", ["tag", local, staging]);
    command("docker", ["push", staging], false);
    const digest = registryDigest(command("docker", ["buildx", "imagetools", "inspect", staging, "--format", "{{json .Manifest}}"]));
    digests.push(`${repo}@${digest}`);
  }
  // Version and latest are promoted only after all required builds and checks.
  // A previous partial publication may have created this tag, but may not be replaced with different bytes.
  const digestValues = digests.map(ref => ref.slice(ref.indexOf("@") + 1));
  const existing = registryManifest(`${repo}:${source.tag}`);
  if (existing) assertDockerManifest(existing, digestValues);
  command("docker", ["buildx", "imagetools", "create", "--tag", `${repo}:${source.tag}`, ...digests], false);
  assertDockerManifest(registryManifest(`${repo}:${source.tag}`), digestValues);
  if (process.env.UPDATE_LATEST === "true") {
    command("docker", ["buildx", "imagetools", "create", "--tag", `${repo}:latest`, ...digests], false);
    assertDockerManifest(registryManifest(`${repo}:latest`), digestValues);
  }
  return { repository: repo, tag: source.tag, images: digests, latestUpdated: process.env.UPDATE_LATEST === "true",
    digest: registryDigest(command("docker", ["buildx", "imagetools", "inspect", `${repo}:${source.tag}`, "--format", "{{json .Manifest}}"])) };
}

async function main() {
  const [mode, kind, directory] = process.argv.slice(2);
  const source = identity();
  if (mode === "stage") { stageFiles(directory, kind, source); return; }
  if (mode === "signing") { prepareSigning(); return; }
  if (mode === "desktop") { await waitDesktop(source); return; }
  if (mode === "verify-artifact") { verifyFiles(directory, kind, source); return; }
  assertTag(source);
  if (mode === "prepare") {
    for (const relative of ["package.json", "package-lock.json", "backend/package.json", "backend/package-lock.json"]) {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, relative)));
      assert.equal(pkg.version, version(source), `version mismatch: ${relative}`);
      if (relative.endsWith("package-lock.json")) assert.equal(pkg.packages[""].version, version(source));
    }
    const gradle = fs.readFileSync(path.join(root, "frontend/android/app/build.gradle"), "utf8");
    assert.equal(gradle.match(/versionName\s+["']([^"']+)/)?.[1], version(source), "Android version mismatch");
    for (const name of ["HAS_ANDROID_SIGNING", "HAS_ANDROID_CERT", "HAS_DOCKER_LOGIN", "HAS_TRUST_ROOTS"])
      assert.equal(process.env[name], "true", `missing GitHub configuration: ${name}`);
    const release = readRelease(source);
    assert.ok(!release || release.draft, "Release already published; choose a new version Tag");
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version(source)}\n`);
    return;
  }
  assert.equal(mode, "publish", "unknown publisher command");
  const incoming = path.resolve("incoming");
  const kinds = ["android", "packages", "docker-amd64", "docker-arm64", ...(process.env.INCLUDE_UPK === "true" ? ["upk"] : [])];
  const allFiles = kinds.flatMap(k => verifyFiles(path.join(incoming, `full-${k}`), k, source));
  const releaseFiles = allFiles.filter(file => !file.name.endsWith(".tar"));
  let release = readRelease(source);
  if (!release) {
    gh(["release", "create", source.tag, "--repo", REPO, "--verify-tag", "--draft", "--title", `Nowen Note ${source.tag}`, "--generate-notes"]);
    release = readRelease(source);
  }
  assert.equal(release.draft, true, "refusing to replace a published Release");
  gh(["release", "upload", source.tag, "--repo", REPO, "--clobber", ...releaseFiles.map(file => file.path)]);
  release = readRelease(source);
  assertUploadedFiles(release.assets, releaseFiles);
  const receipt = await collectRelease({ ...source, requestId: randomUUID(), sourceRunId: process.env.SOURCE_RUN_ID,
    desktop: true, windows: true, linux: true }, { attempt: source.attempt });
  assertUploadedFiles(receipt.assets, releaseFiles);
  assertFullInventory(receipt.assets, source, releaseFiles.map(file => file.name));
  const evidence = { ...receipt, builds: kinds, buildFiles: allFiles.map(({ path: _path, ...file }) => file), publication: "pending" };
  const receiptFile = path.join(process.env.RUNNER_TEMP, "full-release-receipt.json");
  fs.writeFileSync(receiptFile, JSON.stringify(evidence, null, 2));
  const publication = await publishRelease(source, process.env.PUBLISH_RELEASE === "true", receipt.assets.map(asset => ({ ...asset, updated_at: asset.updatedAt })), {
    readRelease, assertTag,
    verifyRemote: () => command(process.execPath, [path.join(root, "scripts/verify-release-update-assets.mjs"), "remote", "--repo", REPO, "--tag", source.tag, "--version", version(source)], false),
    promoteDocker: () => promoteDocker(source, incoming),
    editRelease: () => gh(["release", "edit", source.tag, "--repo", REPO, "--draft=false"]),
  });
  fs.writeFileSync(receiptFile, JSON.stringify({ ...evidence, publication, completedAt: new Date().toISOString() }, null, 2));
  const state = process.env.PUBLISH_RELEASE === "true" ? "Published" : "Draft; Docker version/latest not pushed";
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${source.tag}: ${state}\n\nSource: \`${source.sha}\`\n\nhttps://github.com/${REPO}/releases/tag/${source.tag}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(`[publish] ${error.message}`); process.exitCode = 1; });
