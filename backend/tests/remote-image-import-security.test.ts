import assert from "node:assert/strict";
import test from "node:test";
import {
  isBlockedRemoteAddress,
  isBlockedRemoteHostname,
  sanitizeRemoteImageFilename,
  sniffRemoteImageMime,
} from "../src/lib/remote-image-security";

test("remote image SSRF guard blocks private and metadata targets", () => {
  for (const address of [
    "127.0.0.1", "10.0.0.8", "172.16.0.1", "192.168.1.8",
    "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "fe80::1",
    "::ffff:192.168.1.8",
  ]) {
    assert.equal(isBlockedRemoteAddress(address), true, address);
  }
  assert.equal(isBlockedRemoteHostname("localhost"), true);
  assert.equal(isBlockedRemoteHostname("metadata.google.internal"), true);
  assert.equal(isBlockedRemoteHostname("printer.home"), true);
});

test("remote image SSRF guard permits ordinary public addresses", () => {
  assert.equal(isBlockedRemoteAddress("8.8.8.8"), false);
  assert.equal(isBlockedRemoteAddress("1.1.1.1"), false);
  assert.equal(isBlockedRemoteAddress("2606:4700:4700::1111"), false);
  assert.equal(isBlockedRemoteHostname("images.example.com"), false);
});

test("remote image type is determined from magic bytes", () => {
  assert.equal(sniffRemoteImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniffRemoteImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffRemoteImageMime(Buffer.from("GIF89a", "ascii")), "image/gif");
  assert.equal(sniffRemoteImageMime(Buffer.from("not an image", "utf8")), null);
  assert.equal(sniffRemoteImageMime(Buffer.from("<svg></svg>", "utf8")), null);
});

test("remote image filenames are path-safe and use the detected extension", () => {
  assert.equal(sanitizeRemoteImageFilename("../../evil.exe", "image/png"), "evil.png");
  assert.equal(sanitizeRemoteImageFilename("头像 2026.jpeg", "image/jpeg"), "头像 2026.jpg");
  assert.equal(sanitizeRemoteImageFilename("", "image/webp"), "remote-image.webp");
});
