import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

const ONBOARDING_VERSION = 1;
const LEGACY_TRIGGER_NAME = "users_seed_onboarding_after_insert";
const FIRST_LOGIN_TRIGGER_NAME = "users_seed_onboarding_on_first_login";

function extractTriggerBody(sql: string): string {
  const beginIndex = sql.indexOf("BEGIN");
  const endIndex = sql.lastIndexOf("END");
  if (beginIndex < 0 || endIndex <= beginIndex) {
    throw new Error("[onboarding] cannot extract the v61 seed trigger body");
  }

  const body = sql.slice(beginIndex + "BEGIN".length, endIndex).trim();
  return body.endsWith(";") ? body : `${body};`;
}

/**
 * v62 narrows v61 from every raw user INSERT to the first confirmed login of a
 * newly-created account.
 *
 * Why a separate migration instead of rewriting v61:
 * - published migration history must remain immutable;
 * - existing accounts at upgrade time are explicitly marked as handled;
 * - test fixtures and maintenance scripts that INSERT users no longer receive
 *   16 unrelated notes;
 * - the handled marker survives guide deletion, so login never recreates it.
 */
export const newUserOnboardingFirstLoginMigration: Migration = {
  version: 68,
  name: "new-user-onboarding-first-login-gate",
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_onboarding_state (
        userId TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('existing', 'seeded')),
        completedAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (userId, version),
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_user_onboarding_state_status
        ON user_onboarding_state(version, status);

      -- Every account that already exists while v62 is installed is an old
      -- account. Mark it before enabling the login trigger so upgrades never
      -- add tutorial content to an established workspace.
      INSERT OR IGNORE INTO user_onboarding_state (userId, version, status)
      SELECT id, ${ONBOARDING_VERSION}, 'existing'
      FROM users;
    `);

    const legacy = db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'trigger' AND name = ?
    `).get(LEGACY_TRIGGER_NAME) as { sql: string | null } | undefined;

    if (!legacy?.sql) {
      throw new Error("[onboarding] v61 seed trigger is missing");
    }

    const seedBody = extractTriggerBody(legacy.sql);

    db.exec(`
      DROP TRIGGER IF EXISTS ${LEGACY_TRIGGER_NAME};
      DROP TRIGGER IF EXISTS ${FIRST_LOGIN_TRIGGER_NAME};

      CREATE TRIGGER ${FIRST_LOGIN_TRIGGER_NAME}
      AFTER UPDATE OF lastLoginAt ON users
      WHEN NEW.lastLoginAt IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM user_onboarding_state
          WHERE userId = NEW.id AND version = ${ONBOARDING_VERSION}
        )
      BEGIN
        ${seedBody}

        INSERT INTO user_onboarding_state (
          userId, version, status, completedAt
        ) VALUES (
          NEW.id, ${ONBOARDING_VERSION}, 'seeded', datetime('now')
        );
      END;
    `);
  },
};
