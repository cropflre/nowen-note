import { getDb } from "../db/schema.js";
import { documentDigest, verifySignedDocument } from "./signatures.js";
import type { TrustedRegistryKey } from "./registryTrust.js";

export type AdvisorySeverity = "critical" | "high" | "medium" | "low";
export type AdvisoryAction = "disable" | "recommend" | "warn" | "info";

export interface SecurityAdvisory extends Record<string, unknown> {
  id: string;
  sequence: number;
  pluginId: string;
  affectedVersionRange: string;
  issuedAt: string;
  expiresAt: string;
  severity: AdvisorySeverity;
  action: AdvisoryAction;
  state: "active" | "withdrawn";
  replaces: string | null;
  title: string;
  detailsUrl?: string;
  signerKeyId: string;
  signature: string;
}

export interface AdvisoryApplyResult {
  accepted: string[];
  ignored: Array<{ id: string; reason: string }>;
}

const EXPECTED_ACTION: Record<AdvisorySeverity, AdvisoryAction> = {
  critical: "disable",
  high: "recommend",
  medium: "warn",
  low: "info",
};
const SEVERITY_WEIGHT: Record<AdvisorySeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function matchesComparator(version: [number, number, number], comparator: string): boolean {
  if (comparator === "*" || comparator.toLowerCase() === "x") return true;
  const wildcard = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i.exec(comparator);
  if (wildcard && (wildcard[2] === undefined || /^(x|\*)$/i.test(wildcard[2]) || wildcard[3] === undefined || /^(x|\*)$/i.test(wildcard[3]))) {
    if (version[0] !== Number(wildcard[1])) return false;
    return wildcard[2] === undefined || /^(x|\*)$/i.test(wildcard[2]) || version[1] === Number(wildcard[2]);
  }
  const match = /^(>=|<=|>|<|=|\^|~)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(comparator);
  if (!match) return false;
  const expected = parseVersion(match[2]);
  if (!expected) return false;
  const comparison = compareVersion(version, expected);
  switch (match[1] || "=") {
    case ">=": return comparison >= 0;
    case "<=": return comparison <= 0;
    case ">": return comparison > 0;
    case "<": return comparison < 0;
    case "^": return version[0] === expected[0] && comparison >= 0;
    case "~": return version[0] === expected[0] && version[1] === expected[1] && comparison >= 0;
    default: return comparison === 0;
  }
}

function versionMatchesRange(versionValue: string, range: string): boolean {
  const version = parseVersion(versionValue);
  if (!version || typeof range !== "string" || !range.trim()) return false;
  return range.split("||").some((alternative) => {
    const comparators = alternative.trim().split(/[\s,]+/).filter(Boolean);
    return comparators.length > 0 && comparators.every((comparator) => matchesComparator(version, comparator));
  });
}

function validVersionRangeSyntax(range: string): boolean {
  if (typeof range !== "string" || !range.trim()) return false;
  return range.split("||").every((alternative) => {
    const comparators = alternative.trim().split(/[\s,]+/).filter(Boolean);
    return comparators.length > 0 && comparators.every((comparator) => comparator === "*"
      || /^x$/i.test(comparator)
      || /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i.test(comparator)
      || /^(>=|<=|>|<|=|\^|~)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(comparator));
  });
}

function validAdvisoryShape(advisory: SecurityAdvisory, now: number): string | null {
  if (!advisory || typeof advisory !== "object" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(advisory.id || "")) return "公告 ID 无效";
  if (!Number.isSafeInteger(advisory.sequence) || advisory.sequence < 0) return "公告 sequence 无效";
  if (typeof advisory.pluginId !== "string" || !advisory.pluginId) return "公告 pluginId 无效";
  if (!validVersionRangeSyntax(advisory.affectedVersionRange)) return "公告版本范围无效";
  if (!Object.hasOwn(advisory, "replaces") || advisory.replaces !== null && typeof advisory.replaces !== "string") return "公告 replaces 字段无效";
  if (!Object.hasOwn(EXPECTED_ACTION, advisory.severity) || EXPECTED_ACTION[advisory.severity] !== advisory.action) return "公告 severity/action 不一致";
  if (advisory.state !== "active" && advisory.state !== "withdrawn") return "公告状态无效";
  if (typeof advisory.title !== "string" || !advisory.title.trim()) return "公告标题无效";
  if (typeof advisory.issuedAt !== "string" || typeof advisory.expiresAt !== "string") return "公告时间字段无效";
  const issuedAt = Date.parse(advisory.issuedAt);
  const expiresAt = Date.parse(advisory.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now + MAX_FUTURE_SKEW_MS || expiresAt <= now || expiresAt <= issuedAt) return "公告已过期或时间异常";
  if (typeof advisory.signerKeyId !== "string" || !advisory.signerKeyId || typeof advisory.signature !== "string" || !advisory.signature) return "公告未签名";
  return null;
}

export class SecurityAdvisoryService {
  apply(
    sourceId: string,
    advisories: SecurityAdvisory[],
    trustedKeys: readonly TrustedRegistryKey[],
    now = Date.now(),
  ): AdvisoryApplyResult {
    const accepted: SecurityAdvisory[] = [];
    const ignored: Array<{ id: string; reason: string }> = [];
    const keyById = new Map(trustedKeys.map((key) => [key.keyId, key]));
    const counts = new Map<string, number>();
    for (const advisory of advisories) counts.set(advisory?.id || "", (counts.get(advisory?.id || "") || 0) + 1);

    for (const advisory of advisories) {
      const id = advisory?.id || "unknown";
      if ((counts.get(id) || 0) !== 1) { ignored.push({ id, reason: "同一文档中的公告 ID 不唯一" }); continue; }
      const shapeError = validAdvisoryShape(advisory, now);
      if (shapeError) { ignored.push({ id, reason: shapeError }); continue; }
      const signer = keyById.get(advisory.signerKeyId);
      if (!signer || !verifySignedDocument(advisory, advisory.signature, signer.publicKey)) {
        ignored.push({ id, reason: "公告签名无效或 signer 不受信" });
        continue;
      }
      const previous = getDb().prepare(`SELECT sequence,documentJson,state FROM plugin_security_advisories WHERE sourceId=? AND advisoryId=?`)
        .get(sourceId, id) as { sequence: number; documentJson: string; state: string } | undefined;
      if (previous && advisory.sequence < previous.sequence) { ignored.push({ id, reason: "公告 sequence 回退" }); continue; }
      if (previous && advisory.sequence === previous.sequence) {
        const previousDigest = documentDigest(JSON.parse(previous.documentJson) as Record<string, unknown>);
        if (previousDigest !== documentDigest(advisory)) ignored.push({ id, reason: "公告同 sequence 内容变化" });
        continue;
      }
      if (advisory.state === "withdrawn" && !previous) { ignored.push({ id, reason: "撤回公告不存在" }); continue; }
      if (advisory.replaces) {
        const replaced = getDb().prepare(`SELECT sequence FROM plugin_security_advisories WHERE sourceId=? AND advisoryId=?`)
          .get(sourceId, advisory.replaces) as { sequence: number } | undefined;
        if (!replaced || advisory.sequence <= replaced.sequence) { ignored.push({ id, reason: "replaces 必须指向较低 sequence 的已验证公告" }); continue; }
      }
      accepted.push(advisory);
    }

    if (accepted.length === 0) return { accepted: [], ignored };
    const timestamp = new Date(now).toISOString();
    const db = getDb();
    db.transaction(() => {
      const put = db.prepare(`INSERT INTO plugin_security_advisories(
        sourceId,advisoryId,sequence,pluginId,affectedVersionRange,severity,action,state,title,detailsUrl,
        replacesAdvisoryId,publishedAt,expiresAt,withdrawnAt,signerKeyId,signature,documentJson,verifiedAt,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(sourceId,advisoryId) DO UPDATE SET
        sequence=excluded.sequence,pluginId=excluded.pluginId,affectedVersionRange=excluded.affectedVersionRange,
        severity=excluded.severity,action=excluded.action,state=excluded.state,title=excluded.title,
        detailsUrl=excluded.detailsUrl,replacesAdvisoryId=excluded.replacesAdvisoryId,publishedAt=excluded.publishedAt,
        expiresAt=excluded.expiresAt,withdrawnAt=excluded.withdrawnAt,signerKeyId=excluded.signerKeyId,
        signature=excluded.signature,documentJson=excluded.documentJson,verifiedAt=excluded.verifiedAt,updatedAt=excluded.updatedAt`);
      for (const advisory of accepted) {
        put.run(sourceId, advisory.id, advisory.sequence, advisory.pluginId, advisory.affectedVersionRange,
          advisory.severity, advisory.action, advisory.state, advisory.title, advisory.detailsUrl || null,
          advisory.replaces, advisory.issuedAt, advisory.expiresAt, advisory.state === "withdrawn" ? timestamp : null,
          advisory.signerKeyId, advisory.signature, JSON.stringify(advisory), timestamp, timestamp, timestamp);
        if (advisory.replaces) {
          db.prepare(`UPDATE plugin_security_advisories SET state='withdrawn',withdrawnAt=?,updatedAt=?
            WHERE sourceId=? AND advisoryId=? AND sequence<?`).run(timestamp, timestamp, sourceId, advisory.replaces, advisory.sequence);
        }
        if (advisory.state === "withdrawn" || advisory.replaces) {
          const withdrawnId = advisory.replaces || advisory.id;
          const withdrawn = db.prepare(`SELECT pluginId,affectedVersionRange FROM plugin_security_advisories
            WHERE sourceId=? AND advisoryId=?`).get(sourceId, withdrawnId) as { pluginId: string; affectedVersionRange: string } | undefined;
          const installed = db.prepare("SELECT id,version FROM plugin_registry").all() as Array<{ id: string; version: string }>;
          for (const plugin of installed) {
            if (!withdrawn || plugin.id !== withdrawn.pluginId || !versionMatchesRange(plugin.version, withdrawn.affectedVersionRange)) continue;
            db.prepare(`INSERT INTO plugin_advisory_receipts(
              sourceId,advisoryId,pluginId,pluginVersion,action,outcome,reason,errorCode,processedAt,updatedAt
            ) VALUES (?,?,?,?,?,'applied',NULL,NULL,?,?)
            ON CONFLICT(sourceId,advisoryId,pluginId,pluginVersion,action) DO UPDATE SET outcome='applied',updatedAt=excluded.updatedAt`)
              .run(sourceId, withdrawnId, plugin.id, plugin.version, "withdrawn", timestamp, timestamp);
          }
        }
      }
      this.recomputeInstalledState(timestamp);
    })();
    return { accepted: accepted.map((item) => item.id), ignored };
  }

  list(sourceId?: string): Array<Record<string, unknown>> {
    const rows = sourceId
      ? getDb().prepare("SELECT * FROM plugin_security_advisories WHERE sourceId=? ORDER BY sequence DESC,advisoryId").all(sourceId)
      : getDb().prepare("SELECT * FROM plugin_security_advisories ORDER BY sequence DESC,advisoryId").all();
    return rows as Array<Record<string, unknown>>;
  }

  resetSource(sourceId: string, timestamp = new Date().toISOString()): void {
    const db = getDb();
    db.prepare("DELETE FROM plugin_advisory_receipts WHERE sourceId=?").run(sourceId);
    db.prepare("DELETE FROM plugin_security_advisories WHERE sourceId=?").run(sourceId);
    this.recomputeInstalledState(timestamp);
  }

  private recomputeInstalledState(timestamp: string): void {
    const db = getDb();
    const advisories = db.prepare(`SELECT sourceId,advisoryId,pluginId,affectedVersionRange,severity,action,title,detailsUrl
      FROM plugin_security_advisories WHERE state='active'`).all() as Array<{
      sourceId: string; advisoryId: string; pluginId: string; affectedVersionRange: string; severity: AdvisorySeverity;
      action: AdvisoryAction; title: string; detailsUrl: string | null;
    }>;
    const plugins = db.prepare("SELECT id,version FROM plugin_registry").all() as Array<{ id: string; version: string }>;
    const putState = db.prepare(`INSERT INTO plugin_security_state(pluginId,version,state,severity,advisoryId,title,detailsUrl,action,checkedAt)
      VALUES (?,?,'vulnerable',?,?,?,?,?,?)
      ON CONFLICT(pluginId,version) DO UPDATE SET state='vulnerable',severity=excluded.severity,
      advisoryId=excluded.advisoryId,title=excluded.title,detailsUrl=excluded.detailsUrl,action=excluded.action,checkedAt=excluded.checkedAt`);
    const putReceipt = db.prepare(`INSERT INTO plugin_advisory_receipts(
      sourceId,advisoryId,pluginId,pluginVersion,action,outcome,reason,errorCode,processedAt,updatedAt
    ) VALUES (?,?,?,?,?,'applied',NULL,NULL,?,?)
    ON CONFLICT(sourceId,advisoryId,pluginId,pluginVersion,action) DO UPDATE SET outcome='applied',updatedAt=excluded.updatedAt`);

    for (const plugin of plugins) {
      const matches = advisories
        .filter((advisory) => advisory.pluginId === plugin.id && versionMatchesRange(plugin.version, advisory.affectedVersionRange))
        .sort((left, right) => SEVERITY_WEIGHT[right.severity] - SEVERITY_WEIGHT[left.severity]);
      const strongest = matches[0];
      if (!strongest) {
        db.prepare("DELETE FROM plugin_security_state WHERE pluginId=? AND version=?").run(plugin.id, plugin.version);
        db.prepare("UPDATE plugin_registry SET advisoryState='unknown',updatedAt=? WHERE id=?").run(timestamp, plugin.id);
        continue;
      }
      putState.run(plugin.id, plugin.version, strongest.severity, strongest.advisoryId,
        strongest.title, strongest.detailsUrl, strongest.action, timestamp);
      db.prepare("UPDATE plugin_registry SET advisoryState=?,updatedAt=? WHERE id=?")
        .run(strongest.severity, timestamp, plugin.id);
      if (strongest.severity === "critical") {
        db.prepare(`UPDATE plugin_registry SET status='disabled',
          lastError='Critical 安全公告已自动禁用该版本',updatedAt=? WHERE id=?`).run(timestamp, plugin.id);
      }
      for (const advisory of matches) {
        const receiptAction = advisory.severity === "critical" ? "disabled"
          : advisory.severity === "high" ? "recommended"
            : advisory.severity === "medium" ? "warned" : "informed";
        putReceipt.run(advisory.sourceId, advisory.advisoryId, plugin.id, plugin.version, receiptAction, timestamp, timestamp);
      }
    }
  }
}
