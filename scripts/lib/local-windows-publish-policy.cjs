const WINDOWS_HOST_RE = /^(?:mingw|msys|cygwin|windows|win32)/i;
const MAC_HOST_RE = /^(?:darwin|macos|mac)/i;
const LINUX_HOST_RE = /^(?:linux)/i;

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeTargets(value) {
  const values = splitList(value);
  if (values.includes("all")) {
    return ["docker", "pc", "android", "fpk", "upk", "lite", "clipper"];
  }
  return Array.from(new Set(values));
}

function defaultPcPlatforms(host) {
  const value = String(host || "").trim();
  if (WINDOWS_HOST_RE.test(value)) return ["win"];
  if (MAC_HOST_RE.test(value)) return ["mac", "linux"];
  if (LINUX_HOST_RE.test(value)) return ["win", "linux"];
  return [];
}

function evaluateLocalWindowsPublishPolicy({ targets, pcPlatforms, host, githubRelease }) {
  if (!githubRelease) {
    return { allowed: true, reason: "GitHub Release is disabled" };
  }

  const resolvedTargets = normalizeTargets(targets);
  let resolvedPcPlatforms = splitList(pcPlatforms);
  const hasLinuxApp = resolvedTargets.includes("linux-app");
  const hasPc = resolvedTargets.includes("pc") || hasLinuxApp;
  const hasLite = resolvedTargets.includes("lite");

  if (hasLinuxApp && resolvedPcPlatforms.length === 0) {
    resolvedPcPlatforms = ["linux"];
  } else if (hasPc && resolvedPcPlatforms.length === 0) {
    resolvedPcPlatforms = defaultPcPlatforms(host);
  }

  const fullWindows = hasPc && resolvedPcPlatforms.includes("win");
  const liteWindows = hasLite && WINDOWS_HOST_RE.test(String(host || ""));

  if (fullWindows || liteWindows) {
    const channels = [fullWindows ? "Full" : "", liteWindows ? "Lite" : ""]
      .filter(Boolean)
      .join("/");
    return {
      allowed: false,
      reason:
        `Local GitHub Release would include unsigned Windows ${channels} artifacts. ` +
        "Push a Git tag or use workflow dispatch so GitHub Actions can obtain SignPath signatures. " +
        "For local debug builds, use --no-github-release.",
    };
  }

  return { allowed: true, reason: "No unsigned Windows release artifact is implied" };
}

module.exports = {
  defaultPcPlatforms,
  evaluateLocalWindowsPublishPolicy,
  normalizeTargets,
  splitList,
};
