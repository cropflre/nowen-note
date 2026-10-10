const assert = require("node:assert/strict");
const test = require("node:test");
const { validateWindowsSignatures, discoverWindowsPublisher } = require("../lib/windows-signature-validator.cjs");

const NOW = new Date("2026-08-11T00:00:00.000Z");
const PUBLISHER = "SignPath Foundation";

function validRecord(fileName, overrides = {}) {
  return {
    fileName,
    status: "Valid",
    signerCommonName: PUBLISHER,
    thumbprint: "ABC123",
    signerNotBefore: "2026-01-01T00:00:00.000Z",
    signerNotAfter: "2027-01-01T00:00:00.000Z",
    timestampPresent: true,
    ...overrides,
  };
}

function validate(records, requiredChannels = ["full"]) {
  return validateWindowsSignatures(records, {
    expectedPublisher: PUBLISHER,
    requiredChannels,
    now: NOW,
  });
}

test("accepts valid SignPath records and requires Full/Lite setup packages", () => {
  const result = validate([
    validRecord("Nowen-Note-1.4.16-setup.exe"),
    validRecord("Nowen-Note-1.4.16-portable.exe"),
    validRecord("Nowen-Note-Lite-1.4.16-setup.exe"),
  ], ["full", "lite"]);
  assert.equal(result.setupCounts.full, 1);
  assert.equal(result.setupCounts.lite, 1);
});

test("rejects non-valid Authenticode status and wrong publisher", () => {
  assert.throws(() => validate([validRecord("Nowen-Note-1.4.16-setup.exe", { status: "NotSigned" })]), /status is NotSigned/);
  assert.throws(() => validate([validRecord("Nowen-Note-1.4.16-setup.exe", { signerCommonName: "Other" })]), /does not exactly match/);
});

test("rejects missing required Full or Lite setup", () => {
  assert.throws(() => validate([validRecord("Nowen-Note-Lite-1.4.16-setup.exe")], ["full", "lite"]), /missing required full/);
  assert.throws(() => validate([validRecord("Nowen-Note-1.4.16-setup.exe")], ["full", "lite"]), /missing required lite/);
});

test("expired signer without timestamp is rejected", () => {
  assert.throws(() => validate([
    validRecord("Nowen-Note-1.4.16-setup.exe", {
      signerNotBefore: "2024-01-01T00:00:00.000Z",
      signerNotAfter: "2025-01-01T00:00:00.000Z",
      timestampPresent: false,
    }),
  ]), /outside its validity window/);
});

test("bootstrap discovers the actual common CN only from valid release Full/Lite signatures", () => {
  const records = [
    validRecord("Nowen-Note-1.5.0-setup.exe", { signerCommonName: "Actual Release CN" }),
    validRecord("Nowen-Note-Lite-1.5.0-setup.exe", { signerCommonName: "Actual Release CN" }),
  ];
  const options = { signingPolicy: "release-signing", now: NOW };
  assert.equal(discoverWindowsPublisher(records, options).publisher, "Actual Release CN");
  assert.throws(() => discoverWindowsPublisher(records, { ...options, signingPolicy: "test-signing" }), /never test-signing/);
  assert.throws(() => discoverWindowsPublisher([], options), /requires signed Full\/Lite/);
  assert.throws(() => discoverWindowsPublisher(records.slice(0, 1), options), /missing required lite/);
  assert.throws(() => discoverWindowsPublisher([records[0], { ...records[1], status: "NotSigned" }], options), /status is NotSigned/);
  assert.throws(() => discoverWindowsPublisher([records[0], { ...records[1], signerCommonName: "Different CN" }], options), /does not exactly match/);
  assert.throws(() => validateWindowsSignatures(records, { requiredChannels: ["full", "lite"], now: NOW }), /expectedPublisher is required/);
});
