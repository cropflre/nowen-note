import type Database from "better-sqlite3";
import { ONBOARDING_VERSION, onboardingWelcomeNoteId } from "../db/newUserOnboardingMigration.js";

export function markOnboardingHandled(db: Database.Database, userId: string): void {
  db.prepare(`
    INSERT INTO user_onboarding_state (userId, version, status)
    VALUES (?, ?, 'existing')
  `).run(userId, ONBOARDING_VERSION);
}

export function claimOnboardingWelcome(db: Database.Database, userId: string): string | null {
  const noteId = onboardingWelcomeNoteId(userId);
  const claimed = db.prepare(`
    UPDATE user_onboarding_state
    SET welcomePresentedAt = datetime('now')
    WHERE userId = ? AND version = ? AND status = 'seeded' AND welcomePresentedAt IS NULL
      AND EXISTS (
        SELECT 1 FROM notes
        WHERE id = ? AND userId = ? AND workspaceId IS NULL AND isTrashed = 0
      )
  `).run(userId, ONBOARDING_VERSION, noteId, userId);
  return claimed.changes === 1 ? noteId : null;
}
