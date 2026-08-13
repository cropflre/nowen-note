import assert from "node:assert/strict";
import test from "node:test";

import {
  createAttachmentSignedParams,
  createUserAttachmentScope,
  parseAttachmentAccessScope,
  verifyAttachmentSignatureEnvelope,
} from "../src/lib/attachment-signed-url-core";

test("attachment signature core validates v2 user scopes without database access", () => {
  const previousJwt = process.env.JWT_SECRET;
  const previousAttachmentSecret = process.env.ATTACHMENT_SIGNING_SECRET;
  process.env.JWT_SECRET = "attachment-signature-core-test-secret";
  delete process.env.ATTACHMENT_SIGNING_SECRET;
  try {
    const scope = createUserAttachmentScope("user-1", "note-1", false);
    assert.deepEqual(parseAttachmentAccessScope(scope), {
      version: 2,
      kind: "user",
      subjectId: "user-1",
      noteId: "note-1",
      allowDownload: false,
    });

    const signed = createAttachmentSignedParams("attachment-1", scope, 60_000);
    const verified = verifyAttachmentSignatureEnvelope(
      "attachment-1",
      signed.exp,
      signed.sig,
      signed.scope,
    );
    assert.equal(verified.valid, true);
    assert.equal(verified.accessKind, "user");
    assert.equal(verified.allowDownload, false);
    assert.equal(verified.scope?.noteId, "note-1");

    const replay = verifyAttachmentSignatureEnvelope(
      "attachment-2",
      signed.exp,
      signed.sig,
      signed.scope,
    );
    assert.equal(replay.valid, false);
    assert.equal(replay.reason, "invalid_sig");

    const tamperedScope = createUserAttachmentScope("user-1", "note-2", false);
    const tampered = verifyAttachmentSignatureEnvelope(
      "attachment-1",
      signed.exp,
      signed.sig,
      tamperedScope,
    );
    assert.equal(tampered.valid, false);
    assert.equal(tampered.reason, "invalid_sig");

    const malformed = verifyAttachmentSignatureEnvelope(
      "attachment-1",
      signed.exp,
      "zz-not-hex",
      signed.scope,
    );
    assert.equal(malformed.valid, false);
  } finally {
    if (previousJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwt;
    if (previousAttachmentSecret === undefined) delete process.env.ATTACHMENT_SIGNING_SECRET;
    else process.env.ATTACHMENT_SIGNING_SECRET = previousAttachmentSecret;
  }
});
