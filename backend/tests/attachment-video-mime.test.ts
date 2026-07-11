import assert from "node:assert/strict";
import test from "node:test";
import { inferVideoMime } from "../src/routes/attachments";

test("infers known mobile video MIME types from filenames", () => {
  assert.equal(inferVideoMime("camera.MP4"), "video/mp4");
  assert.equal(inferVideoMime("screen-recording.webm"), "video/webm");
  assert.equal(inferVideoMime("iphone.mov"), "video/quicktime");
  assert.equal(inferVideoMime("android.3gp"), "video/3gpp");
  assert.equal(inferVideoMime("archive.zip"), null);
  assert.equal(inferVideoMime("no-extension"), null);
});
