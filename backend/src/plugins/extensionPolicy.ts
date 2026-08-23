import { getDb } from "../db/schema.js";
import type { PluginManifest, PluginTrustLevel } from "./types.js";

export interface ExtensionPolicyDocument {
  allowOfficial: boolean;
  allowVerified: boolean;
  allowCommunity: boolean;
  allowNodeRuntime: boolean;
  allowedPublishers: string[];
  allowedExtensions: string[];
  blockedExtensions: string[];
}

const DEFAULT_POLICY: ExtensionPolicyDocument = {
  allowOfficial: true, allowVerified: true, allowCommunity: true, allowNodeRuntime: true,
  allowedPublishers: [], allowedExtensions: [], blockedExtensions: [],
};

export class ExtensionPolicy {
  get(): ExtensionPolicyDocument {
    const row = getDb().prepare("SELECT policyJson FROM plugin_policy WHERE id='default'").get() as { policyJson: string } | undefined;
    if (!row) return DEFAULT_POLICY;
    try { return { ...DEFAULT_POLICY, ...JSON.parse(row.policyJson) }; } catch { return DEFAULT_POLICY; }
  }

  set(input: Partial<ExtensionPolicyDocument>, actor: string): ExtensionPolicyDocument {
    const policy = { ...this.get(), ...input };
    for (const key of ["allowedPublishers", "allowedExtensions", "blockedExtensions"] as const) {
      if (!Array.isArray(policy[key]) || policy[key].some((value) => typeof value !== "string")) throw new Error(`${key} 必须是字符串数组`);
      policy[key] = [...new Set(policy[key])];
    }
    getDb().prepare(`INSERT INTO plugin_policy(id,policyJson,updatedBy,updatedAt) VALUES ('default',?,?,?)
      ON CONFLICT(id) DO UPDATE SET policyJson=excluded.policyJson,updatedBy=excluded.updatedBy,updatedAt=excluded.updatedAt`)
      .run(JSON.stringify(policy), actor, new Date().toISOString());
    return policy;
  }

  assertAllowed(manifest: PluginManifest, trust: PluginTrustLevel, source: "package" | "registry" | "dev" | "restore" | "official"): void {
    const policy = this.get();
    if (policy.blockedExtensions.includes(manifest.id)) throw Object.assign(new Error("插件被企业策略阻止"), { code: "PLUGIN_POLICY_DENIED" });
    if (policy.allowedExtensions.length && !policy.allowedExtensions.includes(manifest.id)) throw Object.assign(new Error("插件不在企业允许列表"), { code: "PLUGIN_POLICY_DENIED" });
    if (manifest.apiVersion === 2 && policy.allowedPublishers.length && !policy.allowedPublishers.includes(manifest.publisher)) throw Object.assign(new Error("Publisher 不在企业允许列表"), { code: "PLUGIN_POLICY_DENIED" });
    if (trust === "official" && !policy.allowOfficial || trust === "verified" && !policy.allowVerified || trust === "community" && !policy.allowCommunity) throw Object.assign(new Error("当前信任等级被企业策略禁用"), { code: "PLUGIN_POLICY_DENIED" });
    if (manifest.runtime === "node-action" && !policy.allowNodeRuntime) throw Object.assign(new Error("企业策略禁止 Node Runtime"), { code: "PLUGIN_POLICY_DENIED" });
    if (manifest.apiVersion === 2 && source === "registry" && trust === "community" && manifest.runtime !== "sandbox-js") {
      throw Object.assign(new Error("社区 V2 插件必须使用 sandbox-js"), { code: "PLUGIN_POLICY_DENIED" });
    }
  }
}
