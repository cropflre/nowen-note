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
  assert.match(
    signedUrlSource,
    /attachmentSignedAccessRepository\.findPublication\(/,
  );
});

test("signed attachment repository preserves attachment, share and publication lookups", () => {
  assert.match(repositorySource, /SELECT\s+"noteId"\s+FROM\s+attachments/i);
  assert.match(repositorySource, /SELECT\s+"noteId",\s+"isActive",\s+"expiresAt"\s+FROM\s+shares/i);
  assert.match(repositorySource, /"allowDownload"/);
  assert.match(repositorySource, /WHERE id = \?/);
});

test("signed attachment helper keeps capability, expiry and signature checks", () => {
  assert.match(
    signedUrlSource,
    /resolveEffectiveNoteCapabilities\(scope\.noteId, scope\.subjectId\)/,
  );
  assert.match(signedUrlSource, /capabilities\.read/);
  assert.match(signedUrlSource, /capabilities\.download/);
  assert.match(signedUrlSource, /share_access_revoked/);
  assert.match(signedUrlSource, /share_expired/);
  assert.match(signedUrlSource, /publication_access_revoked/);
  assert.match(signedUrlSource, /timingSafeEqual/);
});
