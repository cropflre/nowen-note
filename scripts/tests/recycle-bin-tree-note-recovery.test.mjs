import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "../..");

async function readRepoFile(relativePath) {
  return readFile(path.join(rootDir, relativePath), "utf8");
}

test("knowledge-tree navigation clears a stale failed note load", async () => {
  const [main, bridge, coordinator] = await Promise.all([
    readRepoFile("frontend/src/main.tsx"),
    readRepoFile("frontend/src/lib/knowledgeTreeNoteLoadRecovery.ts"),
    readRepoFile("frontend/src/lib/noteLoadCoordinator.ts"),
  ]);

  const install = 'installOptionalRuntime("knowledge-tree-note-load-recovery", installKnowledgeTreeNoteLoadRecovery);';
  assert.ok(main.includes(install));
  assert.ok(main.indexOf(install) < main.indexOf("ReactDOM.createRoot(root).render("));
  assert.match(bridge, /data-knowledge-tree-select-id/);
  assert.match(bridge, /primaryNoteLoadCoordinator\.clearFailed\(\)/);
  assert.match(coordinator, /clearFailed\(\): boolean/);
  assert.match(coordinator, /failed\.sink\.finish\(failed\.requestId\)/);
});
