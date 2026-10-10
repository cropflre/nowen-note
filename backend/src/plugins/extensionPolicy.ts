import { getDb } from "../db/schema.js";
import {
  assertExtensionCompatibility,
  resolveExtensionCompatibility,
  type ExtensionCompatibilityInput,
  type ExtensionCompatibilityResult,
  type ExtensionRunner,
} from "./extensionCompatibility.js";

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
  allowOfficial: true, allowVerified: true, allowCommunity: true, allowNodeRuntime: false,
  allowedPublishers: [], allowedExtensions: [], blockedExtensions: [],
};

const LEGACY_DEFAULT_POLICY: ExtensionPolicyDocument = {
  ...DEFAULT_POLICY,
  allowNodeRuntime: true,
};

function isLegacyUnmodifiedDefault(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as ExtensionPolicyDocument;
  return Object.keys(LEGACY_DEFAULT_POLICY).every((key) => {
    const expected = LEGACY_DEFAULT_POLICY[key as keyof ExtensionPolicyDocument];
    const actual = candidate[key as keyof ExtensionPolicyDocument];
    return Array.isArray(expected)
      ? Array.isArray(actual) && actual.length === 0
      : actual === expected;
  });
}

export class ExtensionPolicy {
  get(): ExtensionPolicyDocument {
    const db = getDb();
    const row = db.prepare("SELECT policyJson,updatedBy FROM plugin_policy WHERE id='default'").get() as { policyJson: string; updatedBy: string | null } | undefined;
    if (!row) return DEFAULT_POLICY;
    try {
      const parsed = JSON.parse(row.policyJson) as unknown;
      if (row.updatedBy === null && isLegacyUnmodifiedDefault(parsed)) {
        const timestamp = new Date().toISOString();
        db.prepare("UPDATE plugin_policy SET policyJson=?,updatedBy=?,updatedAt=? WHERE id='default' AND updatedBy IS NULL")
          .run(JSON.stringify(DEFAULT_POLICY), "system:rc1-secure-default", timestamp);
        return { ...DEFAULT_POLICY };
      }
      return { ...DEFAULT_POLICY, ...(parsed as Partial<ExtensionPolicyDocument>) };
    } catch {
      return { ...DEFAULT_POLICY };
    }
  }

  set(input: Partial<ExtensionPolicyDocument>, actor: string): ExtensionPolicyDocument {
    const policy = { ...this.get(), ...input };
    for (const key of ["allowOfficial", "allowVerified", "allowCommunity", "allowNodeRuntime"] as const) {
      if (typeof policy[key] !== "boolean") throw new Error(`${key} 必须是布尔值`);
    }
    for (const key of ["allowedPublishers", "allowedExtensions", "blockedExtensions"] as const) {
      if (!Array.isArray(policy[key]) || policy[key].some((value) => typeof value !== "string")) throw new Error(`${key} 必须是字符串数组`);
      policy[key] = [...new Set(policy[key])];
    }
    getDb().prepare(`INSERT INTO plugin_policy(id,policyJson,updatedBy,updatedAt) VALUES ('default',?,?,?)
      ON CONFLICT(id) DO UPDATE SET policyJson=excluded.policyJson,updatedBy=excluded.updatedBy,updatedAt=excluded.updatedAt`)
      .run(JSON.stringify(policy), actor, new Date().toISOString());
    return policy;
  }

  resolve(input: ExtensionCompatibilityInput): ExtensionCompatibilityResult {
    return resolveExtensionCompatibility(input, this.get());
  }

  assertAllowed(input: ExtensionCompatibilityInput): ExtensionRunner {
    return assertExtensionCompatibility(this.resolve(input));
  }
}
