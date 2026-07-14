import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../src", relativePath), "utf8");
}

const serviceSource = read("services/workspaceNotebookTransfer.ts");
const repositorySource = read("repositories/workspaceNotebookTransferRepository.ts");

test("workspace notebook transfer service delegates database access", () => {
  assert.doesNotMatch(serviceSource, /better-sqlite3/);
  assert.doesNotMatch(serviceSource, /\.\.\/db\/schema/);
  assert.doesNotMatch(serviceSource, /\bgetDb\s*\(/);
  assert.doesNotMatch(serviceSource, /\.prepare\s*\(/);
  assert.match(
    serviceSource,
    /workspaceNotebookTransferRepository\.transaction\(\(\) =>/,
  );
});

test("repository owns the complete transfer transaction and persistence", () => {
  assert.match(repositorySource, /getDb\(\)\.transaction\(work\)\(\)/);
  assert.match(repositorySource, /INSERT INTO notebooks/);
  assert.match(repositorySource, /INSERT INTO notes/);
  assert.match(repositorySource, /INSERT INTO attachments/);
  assert.match(repositorySource, /INSERT INTO tags/);
  assert.match(repositorySource, /INSERT OR IGNORE INTO note_tags/);
  assert.match(repositorySource, /syncAttachmentReferences/);
  assert.match(repositorySource, /syncNoteLinks/);
});

test("transfer safety and compatibility semantics remain guarded", () => {
  assert.match(serviceSource, /MOVE_NOT_SUPPORTED/);
  assert.match(serviceSource, /VERSIONS_NOT_SUPPORTED/);
  assert.match(serviceSource, /ATTACHMENT_FILE_MISSING/);
  assert.match(serviceSource, /TARGET_PARENT_FORBIDDEN/);
  assert.match(serviceSource, /cleanupCreatedFiles\(createdFiles\)/);
  assert.match(serviceSource, /rewriteAttachmentUrls/);
  assert.match(serviceSource, /rewriteInternalNoteLinks/);
  assert.match(serviceSource, /tag_reused_due_unique_constraint/);
  assert.match(serviceSource, /notebook\.transfer_copy/);
});
