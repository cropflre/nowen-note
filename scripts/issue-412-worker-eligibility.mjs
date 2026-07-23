import { readFileSync, writeFileSync } from "node:fs";

const path = "backend/src/services/embedding-worker.ts";
let source = readFileSync(path, "utf8");

function replaceOnce(before, after, label) {
  if (source.includes(after)) return;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, got ${count}`);
  source = source.replace(before, after);
}

replaceOnce(
  `    // The model row is the inexpensive SQL eligibility check. URL/key/profile resolution stays
    // in one TypeScript resolver so fixed profiles, custom credentials and chat fallback agree.
    const tasks = db.prepare(\`
      SELECT q.noteId, q.userId, q.retries
      FROM embedding_queue q
      WHERE q.status = 'pending' AND q.retries < ?
        AND EXISTS (
          SELECT 1 FROM user_ai_settings model
          WHERE model.userId = q.userId
            AND model.key = 'ai_embedding_model'
            AND trim(model.value) <> ''
        )
      ORDER BY q.enqueuedAt ASC
      LIMIT ?
    \`).all(MAX_RETRIES, BATCH_SIZE) as Array<{ noteId: string; userId: string; retries: number }>;`,
  `    // Keep the previous URL pre-filter so invalid chat/custom configurations cannot occupy an
    // entire batch. A fixed Profile ID is an additional eligible source and is validated below.
    const tasks = db.prepare(\`
      SELECT q.noteId, q.userId, q.retries
      FROM embedding_queue q
      WHERE q.status = 'pending' AND q.retries < ?
        AND EXISTS (
          SELECT 1 FROM user_ai_settings model
          WHERE model.userId = q.userId
            AND model.key = 'ai_embedding_model'
            AND trim(model.value) <> ''
        )
        AND (
          EXISTS (
            SELECT 1 FROM user_ai_settings embedding_profile
            WHERE embedding_profile.userId = q.userId
              AND embedding_profile.key = 'ai_embedding_profile_id'
              AND trim(embedding_profile.value) <> ''
          )
          OR EXISTS (
            SELECT 1 FROM user_ai_settings embedding_url
            WHERE embedding_url.userId = q.userId
              AND embedding_url.key = 'ai_embedding_url'
              AND trim(embedding_url.value) <> ''
          )
          OR EXISTS (
            SELECT 1 FROM user_ai_settings api_url
            WHERE api_url.userId = q.userId
              AND api_url.key = 'ai_api_url'
              AND trim(api_url.value) <> ''
          )
          OR NOT EXISTS (
            SELECT 1 FROM user_ai_settings explicit_api_url
            WHERE explicit_api_url.userId = q.userId
              AND explicit_api_url.key = 'ai_api_url'
          )
        )
      ORDER BY q.enqueuedAt ASC
      LIMIT ?
    \`).all(MAX_RETRIES, BATCH_SIZE) as Array<{ noteId: string; userId: string; retries: number }>;`,
  "note queue eligibility",
);

replaceOnce(
  `          WHERE q.status = 'pending' AND q.retries < ?
            AND EXISTS (
              SELECT 1 FROM user_ai_settings model
              WHERE model.userId = q.userId
                AND model.key = 'ai_embedding_model'
                AND trim(model.value) <> ''
            )
          ORDER BY q.enqueuedAt ASC`,
  `          WHERE q.status = 'pending' AND q.retries < ?
            AND EXISTS (
              SELECT 1 FROM user_ai_settings model
              WHERE model.userId = q.userId
                AND model.key = 'ai_embedding_model'
                AND trim(model.value) <> ''
            )
            AND (
              EXISTS (
                SELECT 1 FROM user_ai_settings embedding_profile
                WHERE embedding_profile.userId = q.userId
                  AND embedding_profile.key = 'ai_embedding_profile_id'
                  AND trim(embedding_profile.value) <> ''
              )
              OR EXISTS (
                SELECT 1 FROM user_ai_settings embedding_url
                WHERE embedding_url.userId = q.userId
                  AND embedding_url.key = 'ai_embedding_url'
                  AND trim(embedding_url.value) <> ''
              )
              OR EXISTS (
                SELECT 1 FROM user_ai_settings api_url
                WHERE api_url.userId = q.userId
                  AND api_url.key = 'ai_api_url'
                  AND trim(api_url.value) <> ''
              )
              OR NOT EXISTS (
                SELECT 1 FROM user_ai_settings explicit_api_url
                WHERE explicit_api_url.userId = q.userId
                  AND explicit_api_url.key = 'ai_api_url'
              )
            )
          ORDER BY q.enqueuedAt ASC`,
  "attachment queue eligibility",
);

writeFileSync(path, source);
console.log("Issue #412 queue eligibility patch applied.");
