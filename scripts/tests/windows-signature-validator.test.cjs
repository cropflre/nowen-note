const assert = require("node:assert/strict");
const test = require("node:test");
const { validateWindowsSignatures } = require("../lib/windows-signature-validator.cjs");

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
    validRecord("Nowen-Note-1.4.4-setup.exe"),
    validRecord("Nowen-Note-1.4.4-portable.exe"),
    validRecord("Nowen-Note-Lite-1.4.4-setup.exe"),
  ], ["full", "lite"]);
  assert.equal(result.setupCounts.full, 1);
  assert.equal(result.setupCounts.lite, 1);
  assert.equal(result.records.length, 3);
});

test("rejects non-valid Authenticode statuses", () => {
  for (const status of ["NotSigned", "UnknownError"]) {
    assert.throws(
      () => validate([validRecord("Nowen-Note-1.4.4-setup.exe", { status })]),
      new RegExp(`status is ${status}`),
    );
  }
});

test("rejects missing or mismatched signer identity", () => {
  assert.throws(
    () => validate([validRecord("Nowen-Note-1.4.4-setup.exe", { signerCommonName: "" })]),
    /signerCommonName is missing/,
  );
  assert.throws(
    () => validate([validRecord("Nowen-Note-1.4.4-setup.exe", { signerCommonName: "signpath foundation" })]),
    /does not exactly match 'SignPath Foundation'/,
  );
  assert.throws(
    () => validate([validRecord("Nowen-Note-1.4.4-setup.exe", { thumbprint: "" })]),
    /thumbprint is missing/,
  );
});

test("publisher common name comparison is case-sensitive and exact", () => {
  const record = validRecord("Nowen-Note-1.4.4-setup.exe");
  assert.doesNotThrow(() => validate([record]));
  assert.throws(
    () => validateWindowsSignatures([record], {
      expectedPublisher: "SignPath foundation",
      requiredChannels: ["full"],
      now: NOW,
    }),
    /does not exactly match/,
  );
});

test("expired signer without timestamp is rejected", () => {
  assert.throws(
    () => validate([
      validRecord("Nowen-Note-1.4.4-setup.exe", {
        signerNotBefore: "2024-01-01T00:00:00.000Z",
        signerNotAfter: "2025-01-01T00:00:00.000Z",
        timestampPresent: false,
      }),
    ]),
    /outside its validity window and no timestamp is present/,
  );
  assert.doesNotThrow(() => validate([
    validRecord("Nowen-Note-1.4.4-setup.exe", {
      signerNotBefore: "2024-01-01T00:00:00.000Z",
      signerNotAfter: "2025-01-01T00:00:00.000Z",
      timestampPresent: true,
    }),
  ]));
});

test("missing required Full or Lite setup is rejected", () => {
  assert.throws(
    () => validate([validRecord("Nowen-Note-Lite-1.4.4-setup.exe")], ["full", "lite"]),
    /missing required full NSIS setup executable/,
  );
  assert.throws(
    () => validate([validRecord("Nowen-Note-1.4.4-setup.exe")], ["full", "lite"]),
    /missing required lite NSIS setup executable/,
  );
});

test("multiple setup executables for the same required channel are rejected", () => {
  assert.throws(
    () => validate([
      validRecord("Nowen-Note-1.4.4-setup.exe"),
      validRecord("Nowen-Note-1.4.5-setup.exe"),
    ]),
    /multiple full NSIS setup executables/,
  );
});
