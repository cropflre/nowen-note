// 判断一个版本能不能通过热更新送达已安装的客户端：与上一个正式版比较两端的壳指纹，
// 并把壳的变化翻译成发布说明里看得懂的话。用法见 docs/architecture/hot-update.md「每次发版」。
import { computeRuntimeVersions } from "./fingerprint.mjs";

export const UPDATE_TARGETS = ["android", "desktop"];
const KEYS_FILE = "hot-update/public-keys.json";
const PLATFORM_LABELS = { android: "安卓", desktop: "电脑客户端（Windows、macOS、Linux）" };

/** 提交里有没有可用的热更新公钥。没有的话，这个提交打出的安装包不接受任何热更新。 */
export function hasActiveKey(reader) {
  if (!reader.list(KEYS_FILE).some((entry) => entry.path === KEYS_FILE)) return false;
  const keys = JSON.parse(reader.read(KEYS_FILE).toString("utf8")).keys;
  return Array.isArray(keys) && keys.length > 0;
}

function fileReason(target, file) {
  if (file === KEYS_FILE) return "热更新签名公钥有变化";
  if (target === "desktop") {
    return /^electron\/clipper-(native-)?host\.js$/.test(file) ? "剪藏插件的本机组件有更新" : "桌面启动器和热更新加载器有更新";
  }
  return file === "frontend/capacitor.config.ts" ? "安卓应用配置有更新" : "安卓原生代码有更新";
}

function packageVersions(target, inputs) {
  const pairs = target === "android" ? inputs.packages : [...inputs.packages.root, ...inputs.packages.backendExternal];
  // 平台专属的可选原生包在 lockfile 里可能不存在，指纹里记为 absent。
  return new Map(pairs.filter(([, version]) => version !== "absent"));
}

/** 两个提交之间，某一端的壳为什么变了：去重后的可读原因。 */
export function describeShellChanges(target, before, after) {
  const reasons = [];
  if (before.epoch !== after.epoch) reasons.push("安装包结构有调整");
  const beforeFiles = new Map(before.files);
  const afterFiles = new Map(after.files);
  for (const file of [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort()) {
    if (beforeFiles.get(file) !== afterFiles.get(file)) reasons.push(fileReason(target, file));
  }
  const beforePackages = packageVersions(target, before);
  const afterPackages = packageVersions(target, after);
  for (const name of [...new Set([...beforePackages.keys(), ...afterPackages.keys()])].sort()) {
    const from = beforePackages.get(name);
    const to = afterPackages.get(name);
    if (from === to) continue;
    reasons.push(from === undefined ? `新增 ${name} ${to}` : to === undefined ? `移除 ${name}` : `${name} ${from} → ${to}`);
  }
  return [...new Set(reasons)];
}

/**
 * 比较上一个正式版和本次发版的提交（两个 reader，见 fingerprint.mjs）。
 * 每一端的 mode：
 *   hot          壳没变，已安装上一个版本的客户端能通过热更新收到本版；
 *   full         壳变了，需要安装新安装包，reasons 说明原因；
 *   first        上一个版本没有热更新能力，本版是第一个带热更新能力的安装包；
 *   unavailable  本次提交没有公钥，打出的安装包不接受热更新。
 */
export function compareReleases(previous, current) {
  const currentReady = hasActiveKey(current);
  const previousReady = hasActiveKey(previous);
  const now = currentReady ? computeRuntimeVersions(current) : null;
  const before = currentReady && previousReady ? computeRuntimeVersions(previous) : null;
  const result = {};
  for (const target of UPDATE_TARGETS) {
    if (!now) result[target] = { mode: "unavailable", runtime: null, previousRuntime: null, reasons: [] };
    else if (!before) result[target] = { mode: "first", runtime: now[target], previousRuntime: null, reasons: [] };
    else if (now[target] === before[target]) result[target] = { mode: "hot", runtime: now[target], previousRuntime: before[target], reasons: [] };
    else {
      result[target] = {
        mode: "full",
        runtime: now[target],
        previousRuntime: before[target],
        reasons: describeShellChanges(target, before.inputs[target], now.inputs[target]),
      };
    }
  }
  return result;
}

/** 发布说明「下载与升级」里的「更新方式」一段（Markdown 引用块）。 */
export function renderUpdateMode(result, { previousVersion }) {
  const sentence = ({ mode, reasons }) => {
    if (mode === "hot") return `已经是 v${previousVersion} 的用户会在应用内自动收到本版，重启应用后生效`;
    if (mode === "first") return "本版是第一个支持热更新的版本，需要下载安装一次；之后的多数更新会在应用内直接完成，不用重新安装";
    if (mode === "full") return `需要下载安装新版安装包（${reasons.join("；")}）`;
    return "需要下载安装新版安装包";
  };
  const [android, desktop] = UPDATE_TARGETS.map((target) => sentence(result[target]));
  const unchanged = "Microsoft Store 版、iOS 和 Docker 等服务端的更新方式不变。";
  if (android === desktop) return `> **更新方式：** 安卓和${PLATFORM_LABELS.desktop}：${android}。${unchanged}\n`;
  return [
    "> **更新方式：**",
    `> - ${PLATFORM_LABELS.android}：${android}。`,
    `> - ${PLATFORM_LABELS.desktop}：${desktop}。`,
    ">",
    `> ${unchanged}`,
    "",
  ].join("\n");
}
