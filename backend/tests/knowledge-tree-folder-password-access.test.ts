import assert from "node:assert/strict";
import test from "node:test";

import {
  canViewNoteThroughFolderPasswords,
  resolveUnlockedFolderNodeIds,
  signFolderUnlockToken,
} from "../src/lib/knowledgeTreePasswordAccess.js";

test("folder password access accepts only current tokens and requires every protected ancestor", () => {
  const userId = "password-visibility-user";
  const currentToken = signFolderUnlockToken({
    userId,
    nodeId: "protected-folder",
    notebookId: "protected-notebook",
    passwordVersion: 2,
  });
  const staleToken = signFolderUnlockToken({
    userId,
    nodeId: "stale-folder",
    notebookId: "stale-notebook",
    passwordVersion: 1,
  });

  const db = {
    prepare(sql: string) {
      if (sql.includes("SELECT password.passwordVersion")) {
        return {
          get(nodeId: string) {
            if (nodeId === "protected-folder") return { passwordVersion: 2 };
            if (nodeId === "stale-folder") return { passwordVersion: 3 };
            return undefined;
          },
        };
      }
      if (sql.includes("WITH RECURSIVE ancestors")) {
        return {
          all(noteId: string) {
            return noteId === "protected-note"
              ? [{ nodeId: "protected-folder" }, { nodeId: "nested-folder" }]
              : [];
          },
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  } as any;

  const unlocked = resolveUnlockedFolderNodeIds(db, userId, `${currentToken},${staleToken}`);
  assert.deepEqual([...unlocked], ["protected-folder"]);
  assert.equal(canViewNoteThroughFolderPasswords(db, "legacy-note", unlocked), true);
  assert.equal(canViewNoteThroughFolderPasswords(db, "protected-note", unlocked), false);

  unlocked.add("nested-folder");
  assert.equal(canViewNoteThroughFolderPasswords(db, "protected-note", unlocked), true);
});
