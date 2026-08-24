import { getDb } from "../db/schema.js";
import { isValidSemVerRange, semverSatisfies } from "./semverRange.js";
import { documentDigest, verifySignedDocument } from "./signatures.js";
import type { TrustedRegistryKey } from "./registryTrust.js";

export type AdvisorySeverity = "critical" | "high" | "medium" | "low";
export type AdvisoryAction = "disable" | "recommend" | "warn" | "info";
export type AdvisoryThreatState = "vulnerable" | "revoked" | "malicious";

export interface SecurityAdvisory extends Record<string, unknown> {
  id: string;
  sequence: number;
  pluginId: string;
  affectedVersionRange: string;
  issuedAt: string;
  expiresAt: string;
  severity: AdvisorySeverity;
  action: AdvisoryAction;
  threatState?: AdvisoryThreatState;
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

export interface AdvisoryVersionStatus {
  state: "clear" | "critical" | "high" | "medium" | "low" | "revoked" | "malicious";
  blocked: boolean;
  advisoryIds: string[];
}

const EXPECTED_ACTION: Record<AdvisorySeverity, AdvisoryAction> = {
  critical: "disable",
  high: "recommend",
  medium: "warn",
  low: "info",
};
const SEVERITY_WEIGHT: Record<AdvisorySeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const THREAT_WEIGHT: Record<AdvisoryThreatState, number> = { vulnerable: 0, revoked: 5, malicious: 6 };
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function versionMatchesRange(versionValue: string, range: string): boolean {
  return semverSatisfies(versionValue, range);
}

function validAdvisoryShape(advisory: SecurityAdvisory, now: number): string | null {
  if (!advisory || typeof advisory !== "object" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(advisory.id || "")) return "公告 ID 无效";
  if (!Number.isSafeInteger(advisory.sequence) || advisory.sequence < 0) return "公告 sequence 无效";
  if (typeof advisory.pluginId !== "string" || !advisory.pluginId) return "公告 pluginId 无效";
  if (!isValidSemVerRange(advisory.affectedVersionRange)) return "公告版本范围无效";
  if (!Object.hasOwn(advisory, "replaces") || advisory.replaces !== null && typeof advisory.replaces !== "string") return "公告 replaces 字段无效";
  if (!Object.hasOwn(EXPECTED_ACTION, advisory.severity) || EXPECTED_ACTION[advisory.severity] !== advisory.action) return "公告 severity/action 不一致";
  if (advisory.threatState !== undefined && !["vulnerable", "revoked", "malicious"].includes(advisory.threatState)) return "公告 threatState 无效";
  if (advisory.state !== "active" && advisory.state !== "withdrawn") return "公告状态无效";
  if (typeof advisory.title !== "string" || !advisory.title.trim()) return "公告标题无效";
  if (typeof advisory.issuedAt !== "string" || typeof advisory.expiresAt !== "string") return "公告时间字段无效";
  const issuedAt = Date.parse(advisory.issuedAt);
  const expiresAt = Date.parse(advisory.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now + MAX_FUTURE_SKEW_MS || expiresAt <= now || expiresAt <= issuedAt) return "公告已过期或时间异常";
  if (typeof advisory.signerKeyId !== "string" || !advisory.signerKeyId || typeof advisory.signature !== "string" || !advisory.signature) return "公告未签名";
  return null;
}

function trustedSignerForAdvisory(
  advisory: SecurityAdvisory,
  keyById: ReadonlyMap<string, TrustedRegistryKey>,
  now: number,
): TrustedRegistryKey | null {
  const signer = keyById.get(advisory.signerKeyId);
  if (!signer || signer.state === "revoked") return null;
  const issuedAt = Date.parse(advisory.issuedAt);
  const validFrom = Date.parse(signer.validFrom);
  const validUntil = Date.parse(signer.validUntil);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validUntil)
    || validFrom > issuedAt || validUntil <= issuedAt
    || validFrom > now + MAX_FUTURE_SKEW_MS || validUntil <= now) return null;
  return signer;
}

interface StoredAdvisoryReference {
  advisoryId: string;
  sequence: number;
  pluginId: string;
  state: "active" | "withdrawn" | "expired";
  expiresAt: string;
  documentJson: string;
}

function threatStateOf(advisory: Pick<SecurityAdvisory, "threatState">): AdvisoryThreatState {
  return advisory.threatState || "vulnerable";
}

function derivedState(severity: AdvisorySeverity, threatState: AdvisoryThreatState): AdvisoryVersionStatus["state"] {
  return threatState === "malicious" || threatState === "revoked" ? threatState : severity;
}

export class SecurityAdvisoryService {
  apply(
    sourceId: string,
    advisories: SecurityAdvisory[],
    trustedKeys: readonly TrustedRegistryKey[],
    now = Date.now(),
  ): AdvisoryApplyResult {
    const accepted: SecurityAdvisory[] = [];
    const ignoredById = new Map<string, string>();
    const keyById = new Map(trustedKeys.map((key) => [key.keyId, key]));
    const counts = new Map<string, number>();
    for (const advisory of advisories) counts.set(advisory?.id || "", (counts.get(advisory?.id || "") || 0) + 1);
    const batchIds = new Set(advisories.map((advisory) => advisory?.id || ""));
    const batchReferences = new Map<string, SecurityAdvisory>();
    const candidates = new Map<string, SecurityAdvisory>();
    const storedById = new Map<string, StoredAdvisoryReference | null>();
    const readStored = (advisoryId: string): StoredAdvisoryReference | null => {
      if (storedById.has(advisoryId)) return storedById.get(advisoryId) || null;
      const stored = getDb().prepare(`SELECT advisoryId,sequence,pluginId,state,expiresAt,documentJson
        FROM plugin_security_advisories WHERE sourceId=? AND advisoryId=?`).get(sourceId, advisoryId) as StoredAdvisoryReference | undefined;
      storedById.set(advisoryId, stored || null);
      return stored || null;
    };
    const globalState = getDb().prepare(`SELECT highestSeenSequence,documentJson
      FROM plugin_advisory_sequence_state WHERE sourceId=?`).get(sourceId) as {
      highestSeenSequence: number; documentJson: string;
    } | undefined;
    const globalDigest = globalState
      ? documentDigest(JSON.parse(globalState.documentJson) as Record<string, unknown>)
      : null;

    // 第一阶段只做整批结构、签名、有效窗口和 replay 校验，不依赖输入顺序写库。
    for (const advisory of advisories) {
      const id = advisory?.id || "unknown";
      if ((counts.get(id) || 0) !== 1) { ignoredById.set(id, "同一文档中的公告 ID 不唯一"); continue; }
      const shapeError = validAdvisoryShape(advisory, now);
      if (shapeError) { ignoredById.set(id, shapeError); continue; }
      const signer = trustedSignerForAdvisory(advisory, keyById, now);
      if (!signer || !verifySignedDocument(advisory, advisory.signature, signer.publicKey)) {
        ignoredById.set(id, "公告 signer 不在有效且未撤销的受信根链上，或签名无效");
        continue;
      }
      const previous = readStored(id);
      const advisoryDigest = documentDigest(advisory);
      const previousDigest = previous
        ? documentDigest(JSON.parse(previous.documentJson) as Record<string, unknown>)
        : null;
      if (globalState && advisory.sequence < globalState.highestSeenSequence) {
        if (previous && advisory.sequence === previous.sequence && previousDigest === advisoryDigest) batchReferences.set(id, advisory);
        else ignoredById.set(id, "公告 sequence 低于该 source 已验证的全局最高值");
        continue;
      }
      if (globalState && advisory.sequence === globalState.highestSeenSequence) {
        if (advisoryDigest !== globalDigest || !previous || previous.sequence !== advisory.sequence || previousDigest !== advisoryDigest) {
          ignoredById.set(id, "公告全局同 sequence 内容冲突");
        } else batchReferences.set(id, advisory);
        continue;
      }
      if (previous && advisory.sequence < previous.sequence) { ignoredById.set(id, "公告 sequence 回退"); continue; }
      if (previous && advisory.sequence === previous.sequence) {
        if (previousDigest !== advisoryDigest) ignoredById.set(id, "公告同 sequence 内容变化");
        else batchReferences.set(id, advisory);
        continue;
      }
      if (advisory.state === "withdrawn" && !previous) { ignoredById.set(id, "撤回公告不存在"); continue; }
      candidates.set(id, advisory);
      batchReferences.set(id, advisory);
    }

    const sequenceIds = new Map<number, string[]>();
    for (const [id, advisory] of candidates) {
      const ids = sequenceIds.get(advisory.sequence) || [];
      ids.push(id);
      sequenceIds.set(advisory.sequence, ids);
    }
    for (const ids of sequenceIds.values()) {
      if (ids.length > 1) for (const id of ids) ignoredById.set(id, "同一 source 的 Advisory sequence 必须全局唯一");
    }

    // 第二阶段建立 replacement 图；同批目标优先于数据库目标，非法目标和依赖失效均 fail closed。
    const dependencies = new Map<string, string>();
    const replacementClaims = new Map<string, string[]>();
    for (const [id, advisory] of candidates) {
      if (!advisory.replaces) continue;
      if (advisory.replaces === id) { ignoredById.set(id, "replaces 不能指向自身"); continue; }
      const batchTarget = candidates.get(advisory.replaces);
      const repeatedBatchTarget = batchReferences.has(advisory.replaces) && !batchTarget
        ? readStored(advisory.replaces)
        : null;
      if (!batchTarget && !repeatedBatchTarget && batchIds.has(advisory.replaces)) {
        ignoredById.set(id, "replaces 指向本批无效公告");
        continue;
      }
      const storedTarget = batchTarget || repeatedBatchTarget ? null : readStored(advisory.replaces);
      const target = batchTarget || repeatedBatchTarget || storedTarget;
      if (!target || target.state !== "active" || Date.parse(target.expiresAt) <= now
        || advisory.pluginId !== target.pluginId || advisory.sequence <= target.sequence) {
        ignoredById.set(id, "replaces 必须指向同插件的较低 sequence 已验证公告");
        continue;
      }
      if (batchTarget) dependencies.set(id, advisory.replaces);
      const claims = replacementClaims.get(advisory.replaces) || [];
      claims.push(id);
      replacementClaims.set(advisory.replaces, claims);
    }
    for (const claims of replacementClaims.values()) {
      if (claims.length > 1) {
        for (const id of claims) ignoredById.set(id, "同一公告不能在同批被多次替换");
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, dependency] of dependencies) {
        if (!ignoredById.has(id) && ignoredById.has(dependency)) {
          ignoredById.set(id, "replaces 指向本批无效公告");
          changed = true;
        }
      }
    }

    // Kahn 拓扑排序以 sequence/id 作为稳定次序；无 ready 节点即为 replacement 循环。
    const pending = new Set([...candidates.keys()].filter((id) => !ignoredById.has(id)));
    while (pending.size > 0) {
      const ready = [...pending]
        .filter((id) => !dependencies.has(id) || !pending.has(dependencies.get(id)!))
        .sort((left, right) => candidates.get(left)!.sequence - candidates.get(right)!.sequence || left.localeCompare(right));
      if (ready.length === 0) {
        for (const id of pending) ignoredById.set(id, "replaces 依赖存在循环");
        break;
      }
      for (const id of ready) {
        accepted.push(candidates.get(id)!);
        pending.delete(id);
      }
    }

    const ignored = [...ignoredById].map(([id, reason]) => ({ id, reason }));
    const timestamp = new Date(now).toISOString();
    const db = getDb();
    if (accepted.length === 0) {
      db.transaction(() => {
        this.expireAdvisories(timestamp);
        this.recomputeInstalledState(timestamp);
      })();
      return { accepted: [], ignored };
    }
    db.transaction(() => {
      this.expireAdvisories(timestamp);
      const currentGlobal = db.prepare(`SELECT highestSeenSequence,documentJson
        FROM plugin_advisory_sequence_state WHERE sourceId=?`).get(sourceId) as {
        highestSeenSequence: number; documentJson: string;
      } | undefined;
      for (const advisory of accepted) {
        if (!currentGlobal || advisory.sequence > currentGlobal.highestSeenSequence) continue;
        const stored = db.prepare(`SELECT sequence,documentJson FROM plugin_security_advisories
          WHERE sourceId=? AND advisoryId=?`).get(sourceId, advisory.id) as { sequence: number; documentJson: string } | undefined;
        if (!stored || stored.sequence !== advisory.sequence
          || documentDigest(JSON.parse(stored.documentJson) as Record<string, unknown>) !== documentDigest(advisory)) {
          throw Object.assign(new Error("Advisory 全局 sequence 在并发刷新期间发生回退或冲突"), { code: "ADVISORY_SEQUENCE_ROLLBACK" });
        }
      }
      const put = db.prepare(`INSERT INTO plugin_security_advisories(
        sourceId,advisoryId,sequence,pluginId,affectedVersionRange,severity,action,threatState,state,title,detailsUrl,
        replacesAdvisoryId,publishedAt,expiresAt,withdrawnAt,signerKeyId,signature,documentJson,verifiedAt,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(sourceId,advisoryId) DO UPDATE SET
        sequence=excluded.sequence,pluginId=excluded.pluginId,affectedVersionRange=excluded.affectedVersionRange,
        severity=excluded.severity,action=excluded.action,threatState=excluded.threatState,state=excluded.state,title=excluded.title,
        detailsUrl=excluded.detailsUrl,replacesAdvisoryId=excluded.replacesAdvisoryId,publishedAt=excluded.publishedAt,
        expiresAt=excluded.expiresAt,withdrawnAt=excluded.withdrawnAt,signerKeyId=excluded.signerKeyId,
        signature=excluded.signature,documentJson=excluded.documentJson,verifiedAt=excluded.verifiedAt,updatedAt=excluded.updatedAt`);
      for (const advisory of accepted) {
        if (advisory.replaces) {
          const target = db.prepare(`SELECT sequence,pluginId,state,expiresAt FROM plugin_security_advisories
            WHERE sourceId=? AND advisoryId=?`).get(sourceId, advisory.replaces) as {
            sequence: number; pluginId: string; state: string; expiresAt: string;
          } | undefined;
          if (!target || target.state !== "active" || target.pluginId !== advisory.pluginId
            || target.sequence >= advisory.sequence || Date.parse(target.expiresAt) <= now) {
            throw Object.assign(new Error("Advisory replacement 目标在提交期间失效"), { code: "ADVISORY_REPLACEMENT_INVALID" });
          }
        }
        put.run(sourceId, advisory.id, advisory.sequence, advisory.pluginId, advisory.affectedVersionRange,
          advisory.severity, advisory.action, threatStateOf(advisory), advisory.state, advisory.title, advisory.detailsUrl || null,
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
      const highest = accepted.reduce((current, advisory) => advisory.sequence > current.sequence ? advisory : current);
      db.prepare(`INSERT INTO plugin_advisory_sequence_state(sourceId,highestSeenSequence,documentJson,updatedAt)
        VALUES (?,?,?,?) ON CONFLICT(sourceId) DO UPDATE SET
        highestSeenSequence=excluded.highestSeenSequence,documentJson=excluded.documentJson,updatedAt=excluded.updatedAt
        WHERE excluded.highestSeenSequence>plugin_advisory_sequence_state.highestSeenSequence`)
        .run(sourceId, highest.sequence, JSON.stringify(highest), timestamp);
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

  versionStatus(pluginId: string, version: string, now = Date.now()): AdvisoryVersionStatus {
    const timestamp = new Date(now).toISOString();
    const matches = (getDb().prepare(`SELECT advisory.advisoryId,advisory.affectedVersionRange,
        advisory.severity,advisory.threatState
      FROM plugin_security_advisories advisory
      JOIN plugin_registry_root_chain root
        ON root.sourceId=advisory.sourceId AND root.keyId=advisory.signerKeyId
      WHERE advisory.pluginId=? AND advisory.state='active' AND advisory.expiresAt>?
        AND root.state<>'revoked' AND root.validFrom<=? AND root.validUntil>?`)
      .all(pluginId, timestamp, timestamp, timestamp) as Array<{
      advisoryId: string; affectedVersionRange: string; severity: AdvisorySeverity; threatState: AdvisoryThreatState;
    }>)
      .filter((advisory) => versionMatchesRange(version, advisory.affectedVersionRange))
      .sort((left, right) => THREAT_WEIGHT[right.threatState] - THREAT_WEIGHT[left.threatState]
        || SEVERITY_WEIGHT[right.severity] - SEVERITY_WEIGHT[left.severity]);
    const strongest = matches[0];
    if (!strongest) return { state: "clear", blocked: false, advisoryIds: [] };
    return {
      state: derivedState(strongest.severity, strongest.threatState),
      blocked: strongest.severity === "critical" || strongest.threatState === "revoked" || strongest.threatState === "malicious",
      advisoryIds: matches.map((advisory) => advisory.advisoryId),
    };
  }

  assertInstallAllowed(pluginId: string, version: string): AdvisoryVersionStatus {
    const status = this.versionStatus(pluginId, version);
    if (status.blocked) {
      throw Object.assign(new Error(`插件版本被已验证安全公告阻止安装: ${pluginId}@${version} (${status.state})`), {
        code: "PLUGIN_ADVISORY_BLOCKED",
      });
    }
    return status;
  }

  markInstalledVersionStatus(pluginId: string, version: string): AdvisoryVersionStatus {
    const status = this.versionStatus(pluginId, version);
    if (status.blocked) {
      // 安装提交与公告刷新竞态时，先落地禁用状态，再向调用方 fail closed。
      this.refreshDerivedState();
      throw Object.assign(new Error(`插件版本被已验证安全公告阻止安装: ${pluginId}@${version} (${status.state})`), {
        code: "PLUGIN_ADVISORY_BLOCKED",
      });
    }
    getDb().prepare(`UPDATE plugin_registry SET advisoryState=?,updatedAt=?
      WHERE id=? AND version=?`).run(status.state, new Date().toISOString(), pluginId, version);
    return status;
  }

  refreshDerivedState(now = Date.now(), force = true): void {
    const timestamp = new Date(now).toISOString();
    const db = getDb();
    db.transaction(() => {
      const expired = this.expireAdvisories(timestamp);
      if (force || expired > 0) this.recomputeInstalledState(timestamp);
    })();
  }

  resetSource(sourceId: string, timestamp = new Date().toISOString()): void {
    const db = getDb();
    db.prepare("DELETE FROM plugin_advisory_receipts WHERE sourceId=?").run(sourceId);
    db.prepare("DELETE FROM plugin_security_advisories WHERE sourceId=?").run(sourceId);
    db.prepare("DELETE FROM plugin_advisory_sequence_state WHERE sourceId=?").run(sourceId);
    this.recomputeInstalledState(timestamp);
  }

  private expireAdvisories(timestamp: string): number {
    return getDb().prepare(`UPDATE plugin_security_advisories SET state='expired',updatedAt=?
      WHERE state='active' AND (expiresAt<=? OR NOT EXISTS (
        SELECT 1 FROM plugin_registry_root_chain root
        WHERE root.sourceId=plugin_security_advisories.sourceId
          AND root.keyId=plugin_security_advisories.signerKeyId
          AND root.state<>'revoked' AND root.validFrom<=? AND root.validUntil>?
      ))`).run(timestamp, timestamp, timestamp, timestamp).changes;
  }

  private recomputeInstalledState(timestamp: string): void {
    const db = getDb();
    const advisories = db.prepare(`SELECT advisory.sourceId,advisory.advisoryId,advisory.pluginId,
        advisory.affectedVersionRange,advisory.severity,advisory.action,advisory.threatState,
        advisory.title,advisory.detailsUrl
      FROM plugin_security_advisories advisory
      JOIN plugin_registry_root_chain root
        ON root.sourceId=advisory.sourceId AND root.keyId=advisory.signerKeyId
      WHERE advisory.state='active' AND advisory.expiresAt>?
        AND root.state<>'revoked' AND root.validFrom<=? AND root.validUntil>?`)
      .all(timestamp, timestamp, timestamp) as Array<{
      sourceId: string; advisoryId: string; pluginId: string; affectedVersionRange: string; severity: AdvisorySeverity;
      action: AdvisoryAction; threatState: AdvisoryThreatState; title: string; detailsUrl: string | null;
    }>;
    const plugins = db.prepare("SELECT id,version FROM plugin_registry").all() as Array<{ id: string; version: string }>;
    const putState = db.prepare(`INSERT INTO plugin_security_state(pluginId,version,state,severity,advisoryId,title,detailsUrl,action,checkedAt)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(pluginId,version) DO UPDATE SET state=excluded.state,severity=excluded.severity,
      advisoryId=excluded.advisoryId,title=excluded.title,detailsUrl=excluded.detailsUrl,action=excluded.action,checkedAt=excluded.checkedAt`);
    const putReceipt = db.prepare(`INSERT INTO plugin_advisory_receipts(
      sourceId,advisoryId,pluginId,pluginVersion,action,outcome,reason,errorCode,processedAt,updatedAt
    ) VALUES (?,?,?,?,?,'applied',NULL,NULL,?,?)
    ON CONFLICT(sourceId,advisoryId,pluginId,pluginVersion,action) DO UPDATE SET outcome='applied',updatedAt=excluded.updatedAt`);

    for (const plugin of plugins) {
      const matches = advisories
        .filter((advisory) => advisory.pluginId === plugin.id && versionMatchesRange(plugin.version, advisory.affectedVersionRange))
        .sort((left, right) => THREAT_WEIGHT[right.threatState] - THREAT_WEIGHT[left.threatState]
          || SEVERITY_WEIGHT[right.severity] - SEVERITY_WEIGHT[left.severity]);
      const strongest = matches[0];
      if (!strongest) {
        db.prepare("DELETE FROM plugin_security_state WHERE pluginId=? AND version=?").run(plugin.id, plugin.version);
        db.prepare(`UPDATE plugin_registry SET
          advisoryState=CASE WHEN signatureState='verified' THEN 'clear' ELSE 'unknown' END,
          status=CASE WHEN advisoryAutoDisabled=1 THEN 'enabled' ELSE status END,
          lastError=CASE WHEN advisoryAutoDisabled=1 THEN NULL ELSE lastError END,
          advisoryAutoDisabled=0,updatedAt=? WHERE id=?`).run(timestamp, plugin.id);
        continue;
      }
      putState.run(plugin.id, plugin.version, strongest.threatState, strongest.severity, strongest.advisoryId,
        strongest.title, strongest.detailsUrl, strongest.action, timestamp);
      db.prepare("UPDATE plugin_registry SET advisoryState=?,updatedAt=? WHERE id=?")
        .run(derivedState(strongest.severity, strongest.threatState), timestamp, plugin.id);
      const blocked = strongest.severity === "critical" || strongest.threatState === "revoked" || strongest.threatState === "malicious";
      if (blocked) {
        db.prepare(`UPDATE plugin_registry SET status='disabled',
          advisoryAutoDisabled=CASE WHEN status='enabled' THEN 1 ELSE advisoryAutoDisabled END,
          lastError='安全公告已自动禁用该版本',updatedAt=? WHERE id=?`).run(timestamp, plugin.id);
      } else {
        db.prepare(`UPDATE plugin_registry SET
          status=CASE WHEN advisoryAutoDisabled=1 THEN 'enabled' ELSE status END,
          lastError=CASE WHEN advisoryAutoDisabled=1 THEN NULL ELSE lastError END,
          advisoryAutoDisabled=0,updatedAt=? WHERE id=?`).run(timestamp, plugin.id);
      }
      for (const advisory of matches) {
        const receiptAction = advisory.severity === "critical" || advisory.threatState === "revoked" || advisory.threatState === "malicious" ? "disabled"
          : advisory.severity === "high" ? "recommended"
            : advisory.severity === "medium" ? "warned" : "informed";
        putReceipt.run(advisory.sourceId, advisory.advisoryId, plugin.id, plugin.version, receiptAction, timestamp, timestamp);
      }
    }
  }
}
