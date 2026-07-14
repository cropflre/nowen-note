import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../src", relativePath), "utf8");
}

const memberService = read("queries/memberQueryService.ts");
const attachmentService = read("queries/attachmentQueryService.ts");
const queryIndex = read("queries/index.ts");
const memberRepository = read("repositories/memberQueryRepository.ts");
const attachmentRepository = read("repositories/attachmentQueryRepository.ts");

for (const [name, source] of [
  ["memberQueryService", memberService],
  ["attachmentQueryService", attachmentService],
  ["queries/index", queryIndex],
] as const) {
  test(`${name} keeps database access behind repositories`, () => {
    assert.doesNotMatch(source, /from\s+["']\.\.\/db\/schema["']/);
    assert.doesNotMatch(source, /\bgetDb\s*\(/);
    assert.doesNotMatch(source, /\.prepare\s*\(/);
    assert.doesNotMatch(source, /better-sqlite3/);
  });
}

test("member query service delegates every public query", () => {
  assert.match(memberService, /memberQueryRepository\.getNotebookMemberRole/);
  assert.match(memberService, /memberQueryRepository\.getNoteNotebookMemberRole/);
  assert.match(memberService, /memberQueryRepository\.listSharedNotebookIds/);
  assert.match(memberRepository, /JOIN notebook_members/);
  assert.match(memberRepository, /JOIN notebooks/);
  assert.match(memberRepository, /status = 'active'/);
});

test("attachment query service preserves complex query coverage", () => {
  assert.match(attachmentService, /attachmentQueryRepository\.getUniqueAttachmentPaths/);
  assert.match(attachmentService, /attachmentQueryRepository\.countUniqueAttachmentPaths/);
  assert.match(attachmentService, /attachmentQueryRepository\.getMyUploadsSummary/);
  assert.match(attachmentService, /attachmentQueryRepository\.getNotesReferencingAttachment/);
  assert.match(attachmentRepository, /UNION ALL/);
  assert.match(attachmentRepository, /attachment_references/);
  assert.match(attachmentRepository, /INNER JOIN notes/);
  assert.match(attachmentRepository, /LEFT JOIN notebooks/);
});
