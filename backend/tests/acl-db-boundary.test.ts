import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../src", relativePath), "utf8");
}

const aclSource = read("middleware/acl.ts");
const repositorySource = read("repositories/aclQueryRepository.ts");

test("ACL middleware keeps database access behind repositories", () => {
  assert.doesNotMatch(aclSource, /from\s+["']\.\.\/db\/schema["']/);
  assert.doesNotMatch(aclSource, /\bgetDb\s*\(/);
  assert.doesNotMatch(aclSource, /\.prepare\s*\(/);
  assert.doesNotMatch(aclSource, /better-sqlite3/);
});

test("ACL helpers delegate resource, admin, and feature reads", () => {
  assert.match(aclSource, /aclQueryRepository\.getNoteOwnerScope\(noteId\)/);
  assert.match(aclSource, /aclQueryRepository\.getNotebookOwnerScope\(notebookId\)/);
  assert.match(aclSource, /aclQueryRepository\.getSystemRole\(userId\)/);
  assert.match(aclSource, /aclQueryRepository\.getWorkspaceFeatures\(workspaceId\)/);
});

test("ACL query repository retains the four compatibility queries", () => {
  assert.match(repositorySource, /FROM notes WHERE id = \?/);
  assert.match(repositorySource, /FROM notebooks WHERE id = \?/);
  assert.match(repositorySource, /FROM users WHERE id = \?/);
  assert.match(repositorySource, /FROM workspaces WHERE id = \?/);
  assert.match(repositorySource, /"enabledFeatures"/);
});

test("note permission resolution preserves owner and notebook-member precedence", () => {
  const ownerCheck = aclSource.indexOf("if (note.userId === userId)");
  const notebookMemberCheck = aclSource.indexOf("resolveNoteNotebookMemberPermission(noteId, userId)");
  const personalCheck = aclSource.indexOf("if (!note.workspaceId)");
  const aclCheck = aclSource.indexOf("noteAclRepository.getPermission(noteId, userId)");

  assert.ok(ownerCheck >= 0);
  assert.ok(notebookMemberCheck > ownerCheck);
  assert.ok(personalCheck > notebookMemberCheck);
  assert.ok(aclCheck > personalCheck);
});

test("workspace features remain fail-open for missing or invalid configuration", () => {
  assert.match(aclSource, /if \(!workspaceId\) return \{\};/);
  assert.match(aclSource, /if \(!raw\) return \{\};/);
  assert.match(aclSource, /catch \{[\s\S]*return \{\};/);
  assert.match(aclSource, /return v !== false/);
});
