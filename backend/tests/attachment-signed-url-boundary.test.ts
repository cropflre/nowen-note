import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../src", relativePath), "utf8");
}

const signedUrlSource = read("lib/attachment-signed-url.ts");
const repositorySource = read("repositories/attachmentSignedAccessRepository.ts");

test("signed attachment helper keeps persistence behind a repository", () => {
  assert.doesNotMatch(signedUrlSource, /from\s+["']\.\.\/db\/schema["']/);
  assert.doesNotMatch(signedUrlSource, /\bgetDb\s*\(/);
  assert.doesNotMatch(signedUrlSource, /\.prepare\s*\(/);
  assert.match(
    signedUrlSource,
    /attachmentSignedAccessRepository\.findAttachmentNote\(attachmentId\)/,
  );
  assert.match(
    signedUrlSource,
    /attachmentSignedAccessRepository\.findShare\(scope\.subjectId\)/,
  );
});

test("signed attachment repository preserves attachment and share lookups", () => {
  assert.match(repositorySource, /SELECT\s+"noteId"\s+FROM\s+attachments/i);
  assert.match(repositorySource, /SELECT\s+"noteId",\s+"isActive",\s+"expiresAt"\s+FROM\s+shares/i);
  assert.match(repositorySource, /WHERE id = \?/);
});

test("signed attachment helper keeps ACL and expiry checks", () => {
  assert.match(signedUrlSource, /resolveNotePermission\(scope\.noteId, scope\.subjectId\)/);
  assert.match(signedUrlSource, /hasPermission\(permission, "read"\)/);
  assert.match(signedUrlSource, /share_access_revoked/);
  assert.match(signedUrlSource, /share_expired/);
  assert.match(signedUrlSource, /timingSafeEqual/);
});
