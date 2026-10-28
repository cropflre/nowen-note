import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const source = (await readFile(new URL("../release-legacy.sh", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const functions = ["sync_root_pkg_version", "sync_backend_pkg_version", "android_version_code_of", "sync_android_version"]
  .map((name) => {
    const start = source.indexOf(`${name}() {`);
    assert.ok(start >= 0, `${name} missing`);
    return source.slice(start, source.indexOf("\n}\n", start) + 3);
  }).join("\n");

async function fixture(t, code, version) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nowen-release-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "frontend/android/app"), { recursive: true });
  await mkdir(path.join(root, "backend"));
  await writeFile(path.join(root, "package.json"), '{"version": "1.4.16"}\n');
  await writeFile(path.join(root, "backend/package.json"), '{"version": "1.4.16"}\n');
  await writeFile(path.join(root, "frontend/android/app/build.gradle"), `versionCode ${code}\nversionName "${version}"\n`);
  return root;
}

function sync(root, version, dryRun = false) {
  const result = spawnSync("bash", ["-c", `set -e; info() { :; }; warn() { :; }; ${functions}\nsync_root_pkg_version "$TARGET_VERSION"; sync_backend_pkg_version "$TARGET_VERSION"; sync_android_version "$TARGET_VERSION"`], {
    encoding: "utf8",
    env: { ...process.env, REPO_ROOT: root, TARGET_VERSION: version, DRY_RUN: dryRun ? "1" : "0" },
  });
  assert.equal(result.status, 0, result.stderr);
}

test("Android release sync preserves a higher code for the same version", { skip: process.platform === "win32" }, async (t) => {
  const root = await fixture(t, 10505, "1.5.0");
  sync(root, "1.5.0");
  assert.equal(await readFile(path.join(root, "frontend/android/app/build.gradle"), "utf8"), 'versionCode 10505\nversionName "1.5.0"\n');
});

test("Android next release increments a code above the semver formula", { skip: process.platform === "win32" }, async (t) => {
  const root = await fixture(t, 10505, "1.5.0");
  sync(root, "1.5.1");
  assert.equal(await readFile(path.join(root, "frontend/android/app/build.gradle"), "utf8"), 'versionCode 10506\nversionName "1.5.1"\n');
  sync(root, "1.6.0");
  assert.equal(await readFile(path.join(root, "frontend/android/app/build.gradle"), "utf8"), 'versionCode 10600\nversionName "1.6.0"\n');
});

test("release dry-run leaves root, backend and Android versions unchanged", { skip: process.platform === "win32" }, async (t) => {
  const root = await fixture(t, 10416, "1.4.16");
  sync(root, "1.5.0", true);
  for (const file of ["package.json", "backend/package.json"]) {
    assert.equal(await readFile(path.join(root, file), "utf8"), '{"version": "1.4.16"}\n');
  }
  assert.equal(await readFile(path.join(root, "frontend/android/app/build.gradle"), "utf8"), 'versionCode 10416\nversionName "1.4.16"\n');
});

test("release entry sets a 4GB heap default while preserving explicit limits and other options", { skip: process.platform === "win32" }, async () => {
  const guard = await readFile(new URL("../release-local.sh", import.meta.url), "utf8");
  const initialization = guard.slice(0, guard.indexOf("SCRIPT_DIR="));
  for (const [existing, expected] of [
    ["", "--max-old-space-size=4096"],
    ["--trace-warnings", "--trace-warnings --max-old-space-size=4096"],
    ["--max-old-space-size=6144", "--max-old-space-size=6144"],
    ["--max_old_space_size=3072", "--max_old_space_size=3072"],
  ]) {
    const result = spawnSync("bash", ["-c", `${initialization}\nprintf '%s' "$NODE_OPTIONS"`], {
      encoding: "utf8", env: { ...process.env, NODE_OPTIONS: existing },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
});

test("changelog uses the previous stable tag even after signing bootstrap and RC tags", { skip: process.platform === "win32" }, async (t) => {
  const root = await fixture(t, 10505, "1.5.0");
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
  for (const tag of ["v1.4.16", "v1.5.0", "v1.5.0-signing-bootstrap.1", "v1.5.0-rc.1"]) git("tag", tag);
  const start = source.indexOf("latest_changelog_baseline() {");
  assert.ok(start >= 0);
  const definition = source.slice(start, source.indexOf("\n}\n", start) + 3);
  const result = spawnSync("bash", ["-c", `${definition}\nlatest_changelog_baseline`], {
    cwd: root, encoding: "utf8", env: { ...process.env, VERSION: "1.5.0" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "v1.4.16");
});

test("package sync changes only the application version and preserves dependencies", { skip: process.platform === "win32" }, async (t) => {
  const root = await fixture(t, 10502, "1.5.2");
  for (const file of ["package.json", "backend/package.json"]) {
    await writeFile(path.join(root, file), '{\n  "version": "1.4.16",\n  "description": "fixture",\n  "dependencies": {"dependency": "^1.4.16"}\n}\n');
  }
  sync(root, "1.5.2");
  for (const file of ["package.json", "backend/package.json"]) {
    const content = JSON.parse(await readFile(path.join(root, file), "utf8"));
    assert.equal(content.version, "1.5.2");
    assert.equal(content.dependencies.dependency, "^1.4.16");
  }
});

test("application, lockfile and Android version labels stay aligned without bumping release version", async () => {
  const root = new URL("../../", import.meta.url);
  const version = JSON.parse(await readFile(new URL("package.json", root), "utf8")).version;
  for (const directory of ["", "backend/"]) {
    const pkg = JSON.parse(await readFile(new URL(`${directory}package.json`, root), "utf8"));
    const lock = JSON.parse(await readFile(new URL(`${directory}package-lock.json`, root), "utf8"));
    assert.equal(pkg.version, version);
    assert.equal(lock.version, version);
    assert.equal(lock.packages[""].version, version);
  }
  const android = await readFile(new URL("frontend/android/app/build.gradle", root), "utf8");
  assert.equal(android.match(/versionName\s+["']([^"']+)/)?.[1], version);
});

test("desktop build lockfiles fetch npm tarballs from the official registry", async () => {
  const root = new URL("../../", import.meta.url);
  for (const file of ["package-lock.json", "backend/package-lock.json", "frontend/package-lock.json"]) {
    const lock = JSON.parse(await readFile(new URL(file, root), "utf8"));
    for (const [name, pkg] of Object.entries(lock.packages)) {
      if (pkg.resolved && new URL(pkg.resolved).pathname.endsWith(".tgz")) {
        assert.equal(new URL(pkg.resolved).origin, "https://registry.npmjs.org", `${file}: ${name}`);
      }
    }
  }
});
