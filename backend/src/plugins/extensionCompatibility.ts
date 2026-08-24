import { getDb } from "../db/schema.js";
import { nowenVersionSatisfies } from "./manifest.js";
import type { ExtensionPolicyDocument } from "./extensionPolicy.js";
import type { PluginManifest, PluginRegistryRecord, PluginSource, PluginTrustLevel } from "./types.js";

export interface ExtensionCompatibilityInput {
  manifest: PluginManifest;
  source: PluginSource;
  trustLevel: PluginTrustLevel;
  signatureState: string;
  advisoryState: string;
  nodeRuntimeConfirmed: boolean;
}

export type ExtensionRunner = "node-action" | "sandbox-js";

export type ExtensionCompatibilityResult =
  | { allowed: true; runner: ExtensionRunner }
  | { allowed: false; code: string; reason: string; confirmationRequired?: true };

const INVALID_SIGNATURE_STATES = new Set([
  "invalid",
  "revoked",
  "tampered",
  "verification-failed",
]);

const BLOCKED_ADVISORY_STATES = new Set(["revoked", "malicious", "critical"]);

function denied(code: string, reason: string, confirmationRequired = false): ExtensionCompatibilityResult {
  return confirmationRequired
    ? { allowed: false, code, reason, confirmationRequired: true }
    : { allowed: false, code, reason };
}

function currentRuntimePlatform(): "server" | "desktop-full" {
  return process.env.ELECTRON_USER_DATA ? "desktop-full" : "server";
}

export function resolveExtensionCompatibility(
  input: ExtensionCompatibilityInput,
  policy: ExtensionPolicyDocument,
): ExtensionCompatibilityResult {
  const { manifest } = input;
  const signatureState = input.signatureState.trim().toLowerCase();
  const advisoryState = input.advisoryState.trim().toLowerCase();

  const validTrustSource = input.source === "dev"
    ? input.trustLevel === "developer"
    : input.source === "package"
      ? input.trustLevel === "community"
      : input.source === "official"
        ? input.trustLevel === "official"
        : input.trustLevel !== "developer";
  if (!validTrustSource) {
    return denied("PLUGIN_TRUST_SOURCE_INVALID", "插件来源与信任等级不匹配");
  }

  if (INVALID_SIGNATURE_STATES.has(signatureState)) {
    return denied("PLUGIN_SIGNATURE_INVALID", "插件签名无效或已被撤销");
  }
  if (BLOCKED_ADVISORY_STATES.has(advisoryState)) {
    return denied("PLUGIN_ADVISORY_BLOCKED", "插件版本存在严重安全公告，已拒绝运行");
  }
  if (!nowenVersionSatisfies(manifest.engines.nowen)) {
    return denied("PLUGIN_NOWEN_INCOMPATIBLE", `插件要求 Nowen ${manifest.engines.nowen}`);
  }
  if (manifest.apiVersion === 2) {
    const runtimePlatforms = manifest.runtimePlatform || manifest.platforms;
    if (runtimePlatforms?.length && !runtimePlatforms.includes(currentRuntimePlatform())) {
      return denied("PLUGIN_RUNTIME_PLATFORM_INCOMPATIBLE", "插件与当前 Runtime 平台不兼容");
    }
  }

  if (manifest.apiVersion === 1 && manifest.runtime !== "node-action") {
    return denied("PLUGIN_API_RUNTIME_INCOMPATIBLE", "API V1 仅支持 node-action Runtime");
  }
  if (manifest.apiVersion === 2 && !["node-action", "sandbox-js"].includes(manifest.runtime)) {
    return denied("PLUGIN_API_RUNTIME_INCOMPATIBLE", "API V2 Runtime 不受支持");
  }

  if (policy.blockedExtensions.includes(manifest.id)) {
    return denied("PLUGIN_POLICY_DENIED", "插件被企业策略阻止");
  }
  if (policy.allowedExtensions.length && !policy.allowedExtensions.includes(manifest.id)) {
    return denied("PLUGIN_POLICY_DENIED", "插件不在企业允许列表");
  }
  if (manifest.apiVersion === 2 && policy.allowedPublishers.length && !policy.allowedPublishers.includes(manifest.publisher)) {
    return denied("PLUGIN_POLICY_DENIED", "Publisher 不在企业允许列表");
  }
  if (
    input.trustLevel === "official" && !policy.allowOfficial
    || input.trustLevel === "verified" && !policy.allowVerified
    || input.trustLevel === "community" && !policy.allowCommunity
  ) {
    return denied("PLUGIN_POLICY_DENIED", "当前信任等级被企业策略禁用");
  }

  // V1 是历史兼容 Runtime，全局 V2 Node 开关不能让已安装 V1 失效。
  if (manifest.apiVersion === 1) return { allowed: true, runner: "node-action" };

  if (input.source === "registry" && input.trustLevel === "community" && manifest.runtime === "node-action") {
    return denied("PLUGIN_COMMUNITY_NODE_RUNTIME_DENIED", "Registry Community V2 插件只能使用 sandbox-js");
  }

  const signatureRequired = input.source === "registry"
    || input.source === "official"
    || input.source === "restore"
    || input.trustLevel === "official"
    || input.trustLevel === "verified";
  if (signatureRequired && signatureState !== "verified") {
    return denied("PLUGIN_SIGNATURE_INVALID", "V2 Registry、Official 或 Verified 插件必须通过签名验证");
  }

  if (manifest.runtime === "sandbox-js") return { allowed: true, runner: "sandbox-js" };

  if (["official", "verified"].includes(input.trustLevel) && !policy.allowNodeRuntime) {
    return denied("PLUGIN_POLICY_DENIED", "企业策略禁止 Official/Verified V2 Node Runtime");
  }

  const manualInstall = input.source === "package" || input.source === "dev";
  if (manualInstall) {
    if (!input.nodeRuntimeConfirmed) {
      return denied(
        "PLUGIN_NODE_RUNTIME_CONFIRMATION_REQUIRED",
        "手动安装的 V2 Node Runtime 插件需要当前管理员二次确认",
        true,
      );
    }
    return { allowed: true, runner: "node-action" };
  }

  if (!policy.allowNodeRuntime) {
    return denied("PLUGIN_POLICY_DENIED", "企业策略禁止 V2 Node Runtime");
  }
  return { allowed: true, runner: "node-action" };
}

export function compatibilityInputFromRecord(record: PluginRegistryRecord): ExtensionCompatibilityInput {
  const security = getDb().prepare(`
    SELECT state, severity
    FROM plugin_security_state
    WHERE pluginId = ? AND version = ?
  `).get(record.id, record.version) as { state?: string; severity?: string } | undefined;
  const advisoryState = security?.severity?.trim().toLowerCase() === "critical"
    ? "critical"
    : (security?.state || record.advisoryState || "unknown").trim().toLowerCase();
  return {
    manifest: JSON.parse(record.manifestJson) as PluginManifest,
    source: record.source,
    trustLevel: record.trustLevel,
    signatureState: record.signatureState || "unsigned",
    advisoryState,
    nodeRuntimeConfirmed: Boolean(record.nodeRuntimeConfirmedAt && record.nodeRuntimeConfirmedBy),
  };
}

export function assertExtensionCompatibility(result: ExtensionCompatibilityResult): ExtensionRunner {
  if (result.allowed) return result.runner;
  throw Object.assign(new Error(result.reason), {
    code: result.code,
    confirmationRequired: result.confirmationRequired === true,
  });
}
