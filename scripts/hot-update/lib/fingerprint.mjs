// 壳指纹（runtimeVersion）。
//
// 热更新包只能装到"壳"完全相同的客户端上。壳 = 热更新换不了的部分：
//   安卓：APK 原生代码、清单、资源、Gradle 配置、Capacitor 原生插件版本、capacitor.config.ts；
//   桌面：Electron 版本、app.asar 里的生产依赖、后端原生 external 依赖、bootstrap/加载器等壳文件。
// 所有输入都从 git 提交（默认 HEAD）读取，同一个提交在任何机器上算出同一个值，和工作区脏不脏无关。
//
// 有意不纳入的：electron-builder 配置（electron/builder*.js、build/）。它们大多是构建期校验，
// 纳入会让很多版本白白失去热更新。打包结构的改动如果让新代码依赖了新的资源或过滤规则，
// 必须手动把 hot-update/config.json 里对应的 runtimeEpoch 加一。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const FINGERPRINT_ALGORITHM = 1;
const MAX_BUFFER = 256 * 1024 * 1024;

const ANDROID_ROOT = "frontend/android";
const ANDROID_EXCLUDED = [
  /^frontend\/android\/app\/src\/main\/assets\/public\//, // cap sync 拷进去的前端产物
  /^frontend\/android\/app\/src\/(test|androidTest)\//, // 测试代码不进 APK
  /^frontend\/android\/gradle\/wrapper\//, // 构建工具版本，不改变运行时
  /^frontend\/android\/gradlew(\.bat)?$/,
  /(^|\/)\.gitignore$/,
];
const ANDROID_APP_GRADLE = "frontend/android/app/build.gradle";
const SHARED_SHELL_FILES = ["hot-update/public-keys.json"];
const ANDROID_SHELL_FILES = ["frontend/capacitor.config.ts"];
const DESKTOP_SHELL_FILES = ["electron/main-bootstrap.js", "electron/clipper-host.js", "electron/clipper-native-host.js"];
const DESKTOP_SHELL_DIRS = ["electron/hot-update"];

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 从 git 提交读取文件的 reader；测试里可以换成内存实现。 */
export function gitTreeReader(repoRoot, revision = "HEAD") {
  const git = (args, encoding) =>
    execFileSync("git", ["-C", repoRoot, ...args], { encoding, maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
  return {
    /** @returns {{ path: string, blob: string }[]} 该路径（文件或目录）下所有被跟踪的文件 */
    list(path) {
      return git(["ls-tree", "-r", "-z", "--full-tree", revision, "--", path], "utf8")
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");
          const [, type, blob] = line.slice(0, tab).split(" ");
          return { path: line.slice(tab + 1), type, blob };
        })
        .filter((entry) => entry.type === "blob")
        .map(({ path, blob }) => ({ path, blob }));
    },
    /** @returns {Buffer} */
    read(path) {
      return git(["show", `${revision}:${path}`]);
    },
  };
}

function requiredFile(reader, path) {
  const entries = reader.list(path).filter((entry) => entry.path === path);
  if (entries.length !== 1) throw new Error(`计算壳指纹需要的文件不在提交里：${path}`);
  return entries[0];
}

function readJson(reader, path) {
  requiredFile(reader, path);
  return JSON.parse(reader.read(path).toString("utf8"));
}

function lockVersion(lock, name) {
  const version = lock?.packages?.[`node_modules/${name}`]?.version;
  return typeof version === "string" ? version : null;
}

function requiredLockVersion(lock, name, lockPath) {
  const version = lockVersion(lock, name);
  if (!version) throw new Error(`${lockPath} 里找不到 ${name} 的解析版本`);
  return version;
}

function digestEntry(reader, entry) {
  if (entry.path === ANDROID_APP_GRADLE) {
    return [entry.path, `sha256:${sha256Hex(normalizeAndroidAppGradle(reader.read(entry.path).toString("utf8")))}`];
  }
  return [entry.path, `git:${entry.blob}`];
}

function sortedEntries(entries) {
  return entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** 去掉每次发版都会变的 versionCode / versionName，其余 Gradle 配置照常计入。 */
export function normalizeAndroidAppGradle(text) {
  return text
    .replace(/^[ \t]*versionCode[ \t]+\d+[ \t]*(?:\r?\n|$)/gm, "")
    .replace(/^[ \t]*versionName[ \t]+(["'])[^"'\r\n]*\1[ \t]*(?:\r?\n|$)/gm, "");
}

/** capacitor.settings.gradle 里每个原生插件都指向 ../node_modules/<包名>/... */
export function parseCapacitorPluginPackages(settingsGradle) {
  const names = new Set();
  for (const match of settingsGradle.matchAll(/node_modules\/((?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)\//g)) names.add(match[1]);
  if (!names.size) throw new Error("capacitor.settings.gradle 里没有找到 Capacitor 原生插件");
  return [...names].sort();
}

/** backend/build.bundle.mjs 的 external 名单：这些包运行时从安装目录的 node_modules 解析，属于壳。 */
export function parseBackendExternals(source) {
  const block = source.match(/const external = \[([\s\S]*?)\];/);
  if (!block) throw new Error("backend/build.bundle.mjs 里找不到 `const external = [...]`；请同步更新热更新指纹脚本");
  const names = [...block[1].replace(/\/\/[^\n]*/g, "").matchAll(/["']([^"'\n]+)["']/g)].map((match) => match[1]);
  if (!names.length || names.some((name) => !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name))) {
    throw new Error("backend/build.bundle.mjs 的 external 名单无法解析");
  }
  return [...new Set(names)].sort();
}

function readEpochs(reader) {
  const config = readJson(reader, "hot-update/config.json");
  const epochs = config?.runtimeEpoch;
  for (const target of ["android", "desktop"]) {
    if (!Number.isSafeInteger(epochs?.[target]) || epochs[target] < 1 || epochs[target] > 999999) {
      throw new Error(`hot-update/config.json 的 runtimeEpoch.${target} 必须是 1 到 999999 的整数`);
    }
  }
  return epochs;
}

export function androidRuntimeInputs(reader, epoch) {
  const files = reader
    .list(ANDROID_ROOT)
    .filter((entry) => !ANDROID_EXCLUDED.some((pattern) => pattern.test(entry.path)))
    .map((entry) => digestEntry(reader, entry));
  for (const path of [...ANDROID_SHELL_FILES, ...SHARED_SHELL_FILES]) files.push(digestEntry(reader, requiredFile(reader, path)));
  const settings = reader.read(requiredFile(reader, `${ANDROID_ROOT}/capacitor.settings.gradle`).path).toString("utf8");
  const lock = readJson(reader, "frontend/package-lock.json");
  const names = [...new Set([...parseCapacitorPluginPackages(settings), "@capacitor/android", "@capacitor/core"])].sort();
  return {
    algorithm: FINGERPRINT_ALGORITHM,
    target: "android",
    epoch,
    files: sortedEntries(files),
    packages: names.map((name) => [name, requiredLockVersion(lock, name, "frontend/package-lock.json")]),
  };
}

export function desktopRuntimeInputs(reader, epoch) {
  const files = [];
  for (const path of [...DESKTOP_SHELL_FILES, ...SHARED_SHELL_FILES]) files.push(digestEntry(reader, requiredFile(reader, path)));
  for (const dir of DESKTOP_SHELL_DIRS) for (const entry of reader.list(dir)) files.push(digestEntry(reader, entry));
  const rootPackage = readJson(reader, "package.json");
  const rootLock = readJson(reader, "package-lock.json");
  const rootNames = [...new Set(["electron", ...Object.keys(rootPackage.dependencies || {})])].sort();
  const externals = parseBackendExternals(reader.read(requiredFile(reader, "backend/build.bundle.mjs").path).toString("utf8"));
  const backendLock = readJson(reader, "backend/package-lock.json");
  return {
    algorithm: FINGERPRINT_ALGORITHM,
    target: "desktop",
    epoch,
    files: sortedEntries(files),
    packages: {
      root: rootNames.map((name) => [name, requiredLockVersion(rootLock, name, "package-lock.json")]),
      // 平台专属的可选包（如 sqlite-vec-windows-x64）不一定出现在 lockfile 里，记为 absent。
      backendExternal: externals.map((name) => [name, lockVersion(backendLock, name) ?? "absent"]),
    },
  };
}

export function runtimeVersionOf(inputs) {
  return `e${inputs.epoch}-${sha256Hex(canonicalJson(inputs)).slice(0, 16)}`;
}

export function computeRuntimeVersions(reader) {
  const epochs = readEpochs(reader);
  const inputs = { android: androidRuntimeInputs(reader, epochs.android), desktop: desktopRuntimeInputs(reader, epochs.desktop) };
  return { android: runtimeVersionOf(inputs.android), desktop: runtimeVersionOf(inputs.desktop), inputs };
}
