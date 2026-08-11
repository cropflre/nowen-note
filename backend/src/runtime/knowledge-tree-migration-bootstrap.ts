import { MIGRATIONS } from "../db/migrations.js";

const REQUIRED_KNOWLEDGE_TREE_MIGRATIONS = [60, 61, 62, 63, 64, 65] as const;

/**
 * Compatibility bootstrap kept for historical entry points.
 *
 * Versions 60-65 are now part of the canonical migration registry. This module
 * must never mutate the migration list at runtime: doing so after migrations.ts
 * has already imported the same feature migrations creates duplicate versions
 * and makes database startup fail. The bootstrap now only verifies that a build
 * did not accidentally omit the published knowledge-tree chain.
 */
for (const version of REQUIRED_KNOWLEDGE_TREE_MIGRATIONS) {
  if (!MIGRATIONS.some((migration) => migration.version === version)) {
    throw new Error(`[knowledge-tree-bootstrap] missing canonical migration v${version}`);
  }
}
