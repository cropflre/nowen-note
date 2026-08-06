import Database from "better-sqlite3";

export type SqlitePostgresDrillFixtureProfile = "medium" | "large";

export type SqlitePostgresDrillFixtureSummary = {
  profile: SqlitePostgresDrillFixtureProfile;
  accounts: number;
  events: number;
  totalRows: number;
};

const PROFILE_ROWS: Record<SqlitePostgresDrillFixtureProfile, {
  accounts: number;
  eventsPerAccount: number;
}> = {
  medium: { accounts: 120, eventsPerAccount: 4 },
  large: { accounts: 400, eventsPerAccount: 4 },
};

function accountId(index: number): string {
  return `account-${String(index).padStart(6, "0")}`;
}

function eventId(index: number): string {
  return `event-${String(index).padStart(8, "0")}`;
}

export function createSqlitePostgresDrillFixture(
  path: string,
  profile: SqlitePostgresDrillFixtureProfile,
): SqlitePostgresDrillFixtureSummary {
  const shape = PROFILE_ROWS[profile];
  const db = new Database(path);
  try {
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, name) VALUES (78, 'drill-fixture');

      CREATE TABLE migration_drill_accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        profile TEXT NOT NULL,
        avatar BLOB NOT NULL,
        quota INTEGER NOT NULL
      );

      CREATE TABLE migration_drill_events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES migration_drill_accounts(id)
      );
    `);
    const insertAccount = db.prepare(
      `INSERT INTO migration_drill_accounts
         (id, email, enabled, created_at, profile, avatar, quota)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = db.prepare(
      `INSERT INTO migration_drill_events
         (id, account_id, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertAll = db.transaction(() => {
      for (let accountIndex = 1; accountIndex <= shape.accounts; accountIndex += 1) {
        const id = accountId(accountIndex);
        insertAccount.run(
          id,
          `${id}@example.invalid`,
          accountIndex % 3 === 0 ? 0 : 1,
          new Date(Date.UTC(2026, 7, 1, 0, accountIndex % 60, 0)).toISOString(),
          JSON.stringify({
            profile,
            accountIndex,
            flags: ["migration", accountIndex % 2 === 0 ? "even" : "odd"],
          }),
          Buffer.from(`avatar:${profile}:${accountIndex}`),
          9_000_000_000_000_000n + BigInt(accountIndex),
        );
      }
      const totalEvents = shape.accounts * shape.eventsPerAccount;
      for (let eventIndex = 1; eventIndex <= totalEvents; eventIndex += 1) {
        const ownerIndex = ((eventIndex - 1) % shape.accounts) + 1;
        insertEvent.run(
          eventId(eventIndex),
          accountId(ownerIndex),
          eventIndex % 5 === 0 ? "checkpoint" : "edit",
          JSON.stringify({
            profile,
            eventIndex,
            content: `deterministic-payload-${eventIndex}`,
          }),
          new Date(Date.UTC(2026, 7, 2, 0, eventIndex % 60, 0)).toISOString(),
        );
      }
    });
    insertAll();
    const events = shape.accounts * shape.eventsPerAccount;
    return {
      profile,
      accounts: shape.accounts,
      events,
      totalRows: shape.accounts + events,
    };
  } finally {
    db.close();
  }
}

export const sqlitePostgresDrillFixtureIds = {
  accountId,
  eventId,
};
