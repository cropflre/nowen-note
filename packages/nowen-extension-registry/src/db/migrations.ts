import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  name: string;
  sql: string;
}
const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "registry_core",
    sql: `
      CREATE TABLE IF NOT EXISTS developers(id TEXT PRIMARY KEY,githubId TEXT UNIQUE NOT NULL,login TEXT NOT NULL,avatar TEXT,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publishers(id TEXT PRIMARY KEY,displayName TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',website TEXT,github TEXT,verified INTEGER NOT NULL DEFAULT 0,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publisher_members(publisherId TEXT NOT NULL,developerId TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(publisherId,developerId));
      CREATE TABLE IF NOT EXISTS publisher_keys(id TEXT PRIMARY KEY,publisherId TEXT NOT NULL,publicKey TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'active',validFrom TEXT NOT NULL,validUntil TEXT,revokedAt TEXT);
      CREATE TABLE IF NOT EXISTS extensions(id TEXT PRIMARY KEY,publisherId TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,repository TEXT NOT NULL,license TEXT NOT NULL,trustLevel TEXT NOT NULL DEFAULT 'community',listed INTEGER NOT NULL DEFAULT 1,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS extension_versions(extensionId TEXT NOT NULL,version TEXT NOT NULL,apiVersion INTEGER NOT NULL,runtime TEXT NOT NULL,manifestJson TEXT NOT NULL,artifactPath TEXT NOT NULL,artifactUrl TEXT NOT NULL,sha256 TEXT NOT NULL,publisherKeyId TEXT NOT NULL,signature TEXT NOT NULL,scanState TEXT NOT NULL,scanReportJson TEXT NOT NULL,publishedAt TEXT NOT NULL,PRIMARY KEY(extensionId,version));
      CREATE TABLE IF NOT EXISTS extension_reviews(id TEXT PRIMARY KEY,extensionId TEXT NOT NULL,version TEXT NOT NULL,developerId TEXT NOT NULL,rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),comment TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,UNIQUE(extensionId,version,developerId));
      CREATE TABLE IF NOT EXISTS extension_reports(id TEXT PRIMARY KEY,extensionId TEXT NOT NULL,version TEXT,developerId TEXT NOT NULL,reason TEXT NOT NULL,details TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_advisories(id TEXT PRIMARY KEY,extensionId TEXT NOT NULL,versionsJson TEXT NOT NULL,state TEXT NOT NULL,severity TEXT NOT NULL,title TEXT NOT NULL,detailsUrl TEXT,action TEXT NOT NULL DEFAULT 'warn',createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS daily_extension_stats(day TEXT NOT NULL,extensionId TEXT NOT NULL,event TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,extensionId,event));
    `,
  },
  {
    version: 2,
    name: "production_security_foundation",
    sql: `
      CREATE TABLE oauth_states(
        stateHash TEXT PRIMARY KEY,
        verifierCiphertext TEXT NOT NULL,
        verifierIv TEXT NOT NULL,
        verifierTag TEXT NOT NULL,
        redirectUri TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        consumedAt TEXT,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE sessions(
        id TEXT PRIMARY KEY,
        tokenHash TEXT UNIQUE NOT NULL,
        csrfHash TEXT NOT NULL,
        developerId TEXT,
        adminUserId TEXT,
        expiresAt TEXT NOT NULL,
        lastUsedAt TEXT NOT NULL,
        revokedAt TEXT,
        rotatedFrom TEXT,
        createdAt TEXT NOT NULL,
        CHECK ((developerId IS NOT NULL) <> (adminUserId IS NOT NULL))
      );
      CREATE INDEX sessions_token_active_idx ON sessions(tokenHash,expiresAt,revokedAt);
      CREATE TABLE rate_limit_buckets(
        bucketKey TEXT PRIMARY KEY,
        tokens REAL NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE publisher_quotas(
        publisherId TEXT NOT NULL,
        day TEXT NOT NULL,
        publishCount INTEGER NOT NULL DEFAULT 0,
        artifactBytes INTEGER NOT NULL DEFAULT 0,
        lastPublishedAt TEXT,
        PRIMARY KEY(publisherId,day)
      );
      CREATE TABLE admin_users(
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        passwordHash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE admin_totp(
        adminUserId TEXT PRIMARY KEY,
        secretCiphertext TEXT NOT NULL,
        secretIv TEXT NOT NULL,
        secretTag TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE audit_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actorType TEXT NOT NULL,
        actorId TEXT,
        action TEXT NOT NULL,
        targetType TEXT NOT NULL,
        targetId TEXT,
        metadataJson TEXT NOT NULL,
        ipAddress TEXT,
        createdAt TEXT NOT NULL
      );
      CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
      CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
      CREATE TABLE registry_metadata_sequence(
        documentType TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL DEFAULT 0,
        digest TEXT,
        signerKeyId TEXT,
        generatedAt TEXT,
        expiresAt TEXT
      );
      CREATE TABLE artifact_objects(
        sha256 TEXT PRIMARY KEY,
        storageKey TEXT UNIQUE NOT NULL,
        sizeBytes INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'staged',
        createdAt TEXT NOT NULL,
        committedAt TEXT
      );
      CREATE TABLE registry_mirrors(
        id TEXT PRIMARY KEY,
        baseUrl TEXT NOT NULL,
        publicKey TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 100,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: "signed_security_advisories",
    sql: `
      ALTER TABLE security_advisories RENAME TO security_advisories_legacy_v2;
      CREATE TABLE security_advisories(
        id TEXT PRIMARY KEY,
        sequence INTEGER UNIQUE NOT NULL,
        pluginId TEXT NOT NULL,
        affectedVersionRange TEXT NOT NULL,
        issuedAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low')),
        action TEXT NOT NULL CHECK(action IN ('disable','recommend','warn','info')),
        state TEXT NOT NULL CHECK(state IN ('active','withdrawn')),
        replaces TEXT,
        title TEXT NOT NULL,
        detailsUrl TEXT,
        signerKeyId TEXT NOT NULL,
        signature TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX security_advisories_plugin_idx ON security_advisories(pluginId,state,sequence);
    `,
  },
];

export function runRegistryMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS registry_schema_migrations(
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      appliedAt TEXT NOT NULL
    );
  `);
  const applied = new Set((db.prepare("SELECT version FROM registry_schema_migrations").all() as Array<{ version: number }>).map((row) => row.version));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO registry_schema_migrations(version,name,appliedAt) VALUES (?,?,?)").run(migration.version, migration.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`Registry migration ${migration.version} (${migration.name}) failed`, { cause: error });
    }
  }
}
