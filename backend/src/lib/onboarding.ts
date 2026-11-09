import type Database from "better-sqlite3";
import { ONBOARDING_VERSION, onboardingWelcomeNoteId } from "../db/newUserOnboardingMigration.js";

// Positive versions identify guide content. Negative versions track presentation.
const WELCOME_VERSION = -ONBOARDING_VERSION;

export function markOnboardingHandled(db: Database.Database, userId: string): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO user_onboarding_state (userId, version, status)
    VALUES (?, ?, 'existing')
  `);
  insert.run(userId, ONBOARDING_VERSION);
  insert.run(userId, WELCOME_VERSION);
}

export function recordOnboardingLogin(db: Database.Database, userId: string): void {
  db.transaction(() => {
    const handled = db.prepare("SELECT 1 FROM user_onboarding_state WHERE userId = ? AND version = ?")
      .get(userId, ONBOARDING_VERSION);
    db.prepare("UPDATE users SET lastLoginAt = datetime('now') WHERE id = ?").run(userId);
    if (!handled) {
      // Grant presentation only when this login actually created the guide.
      db.prepare(`
        INSERT OR IGNORE INTO user_onboarding_state (userId, version, status)
        SELECT userId, ?, 'seeded' FROM user_onboarding_state
        WHERE userId = ? AND version = ? AND status = 'seeded'
      `).run(WELCOME_VERSION, userId, ONBOARDING_VERSION);
    }
  })();
}

export function claimOnboardingWelcome(db: Database.Database, userId: string): string | null {
  const noteId = onboardingWelcomeNoteId(userId);
  const claimed = db.prepare(`
    UPDATE user_onboarding_state
    SET status = 'existing', completedAt = datetime('now')
    WHERE userId = ? AND version = ? AND status = 'seeded'
      AND EXISTS (
        SELECT 1 FROM notes
        WHERE id = ? AND userId = ? AND workspaceId IS NULL AND isTrashed = 0
      )
  `).run(userId, WELCOME_VERSION, noteId, userId);
  return claimed.changes === 1 ? noteId : null;
}
