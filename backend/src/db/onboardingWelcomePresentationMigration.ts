import type { Migration } from "./migrations.impl.js";
import { ONBOARDING_VERSION } from "./newUserOnboardingMigration.js";

export const onboardingWelcomePresentationMigration: Migration = {
  // v141–145 are in release/v1.6.0. The registry applies each migration by ID.
  version: 146,
  name: "onboarding-welcome-presentation",
  up(db) {
    db.exec(`
      ALTER TABLE user_onboarding_state ADD COLUMN welcomePresentedAt TEXT;

      -- Some managed desktop identities were created without a login timestamp.
      -- Suppress delayed seeding and welcome reopening for all upgrade accounts.
      INSERT OR IGNORE INTO user_onboarding_state (userId, version, status)
      SELECT id, ${ONBOARDING_VERSION}, 'existing' FROM users;

      UPDATE user_onboarding_state
      SET welcomePresentedAt = datetime('now')
      WHERE version = ${ONBOARDING_VERSION};
    `);
  },
};
