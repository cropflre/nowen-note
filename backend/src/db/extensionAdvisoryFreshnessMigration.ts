import type { Migration } from "./migrations.impl.js";

function hasColumn(db: any, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);
}

/** 为 Advisory 增加威胁分类与按 source 的全局 sequence 防回放状态。 */
export const extensionAdvisoryFreshnessMigration: Migration = {
  version: 99,
  name: "extension-advisory-trust-freshness",
  up: (db) => {
    if (!hasColumn(db, "plugin_registry", "advisoryAutoDisabled")) {
      db.exec("ALTER TABLE plugin_registry ADD COLUMN advisoryAutoDisabled INTEGER NOT NULL DEFAULT 0 CHECK (advisoryAutoDisabled IN (0, 1))");
    }
    if (!hasColumn(db, "plugin_security_advisories", "threatState")) {
      db.exec(`ALTER TABLE plugin_security_advisories ADD COLUMN threatState TEXT NOT NULL DEFAULT 'vulnerable'
        CHECK (threatState IN ('vulnerable', 'revoked', 'malicious'))`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_advisory_sequence_state (
        sourceId TEXT PRIMARY KEY,
        highestSeenSequence INTEGER NOT NULL CHECK (highestSeenSequence >= 0),
        documentJson TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (sourceId) REFERENCES plugin_sources(id) ON DELETE CASCADE
      );
    `);
    const duplicate = db.prepare(`SELECT sourceId,sequence,COUNT(*) AS count
      FROM plugin_security_advisories GROUP BY sourceId,sequence HAVING COUNT(*)>1 LIMIT 1`).get() as {
      sourceId: string; sequence: number; count: number;
    } | undefined;
    if (duplicate) {
      throw new Error(`Advisory 历史数据存在全局 sequence 冲突: ${duplicate.sourceId}@${duplicate.sequence}`);
    }
    const rows = db.prepare(`SELECT sourceId,sequence,documentJson,updatedAt
      FROM plugin_security_advisories ORDER BY sourceId,sequence DESC,advisoryId`).all() as Array<{
      sourceId: string; sequence: number; documentJson: string; updatedAt: string;
    }>;
    const seen = new Set<string>();
    const put = db.prepare(`INSERT OR IGNORE INTO plugin_advisory_sequence_state(
      sourceId,highestSeenSequence,documentJson,updatedAt
    ) VALUES (?,?,?,?)`);
    for (const row of rows) {
      const document = JSON.parse(row.documentJson) as { sequence?: unknown };
      if (document.sequence !== row.sequence) {
        throw new Error(`Advisory 历史文档 sequence 不一致: ${row.sourceId}@${row.sequence}`);
      }
      if (seen.has(row.sourceId)) continue;
      seen.add(row.sourceId);
      put.run(row.sourceId, row.sequence, row.documentJson, row.updatedAt);
    }
  },
};
