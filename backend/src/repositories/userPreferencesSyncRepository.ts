import { getDatabaseAdapter } from "../db/runtime";

export interface UserPreferenceDocumentRow {
  preferencesJson: string;
  updatedAt: string;
}

export const userPreferencesSyncRepository = {
  async getByUserAsync(userId: string): Promise<UserPreferenceDocumentRow | undefined> {
    return getDatabaseAdapter().queryOne<UserPreferenceDocumentRow>(
      'SELECT "preferencesJson", "updatedAt" FROM user_preferences WHERE "userId" = ?',
      [userId],
    );
  },

  async upsertAsync(input: {
    userId: string;
    preferencesJson: string;
    updatedAt: string;
  }): Promise<void> {
    await getDatabaseAdapter().execute(
      `INSERT INTO user_preferences ("userId", "preferencesJson", "updatedAt")
       VALUES (?, ?, ?)
       ON CONFLICT("userId") DO UPDATE SET
         "preferencesJson" = excluded."preferencesJson",
         "updatedAt" = excluded."updatedAt"`,
      [input.userId, input.preferencesJson, input.updatedAt],
    );
  },
};
