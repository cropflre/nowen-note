const path = require("node:path");

const CHANNELS = new Set(["full", "lite"]);

function parseDate(value, label, fileName) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new Error(`${fileName}: ${label} is missing or invalid`);
  }
  return date;
}

function channelForSetup(fileName) {
  const name = path.basename(String(fileName || ""));
  if (/^Nowen-Note-Lite-.+-setup\.exe$/.test(name)) return "lite";
  if (/^Nowen-Note-.+-setup\.exe$/.test(name) && !/^Nowen-Note-Lite-/.test(name)) return "full";
  return null;
}

function validateWindowsSignatures(records, { expectedPublisher, requiredChannels = [], now = new Date() } = {}) {
  if (!Array.isArray(records)) throw new Error("signature report must be a JSON array");
  const publisher = String(expectedPublisher || "");
  if (!publisher.trim()) throw new Error("expectedPublisher is required");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now must be a valid Date");

  const required = Array.from(new Set(requiredChannels.map((value) => String(value).trim()).filter(Boolean)));
  for (const channel of required) {
    if (!CHANNELS.has(channel)) throw new Error(`unknown required channel: ${channel}`);
  }

  const setupCounts = { full: 0, lite: 0 };
  const normalized = [];

  for (const record of records) {
    const fileName = path.basename(String(record?.fileName || ""));
    if (!fileName || !/\.exe$/i.test(fileName)) throw new Error("signature record contains an invalid executable fileName");
    const status = String(record?.status || "");
    const signerCommonName = String(record?.signerCommonName || "");
    const thumbprint = String(record?.thumbprint || "").trim();

    if (status !== "Valid") throw new Error(`${fileName}: Authenticode status is ${status || "<empty>"}, expected Valid`);
    if (!signerCommonName) throw new Error(`${fileName}: signerCommonName is missing`);
    if (signerCommonName !== publisher) {
      throw new Error(`${fileName}: signerCommonName '${signerCommonName}' does not exactly match '${publisher}'`);
    }
    if (!thumbprint) throw new Error(`${fileName}: signer thumbprint is missing`);

    const signerNotBefore = parseDate(record.signerNotBefore, "signerNotBefore", fileName);
    const signerNotAfter = parseDate(record.signerNotAfter, "signerNotAfter", fileName);
    if (signerNotAfter < signerNotBefore) throw new Error(`${fileName}: signer certificate validity range is invalid`);

    const timestampPresent = record.timestampPresent === true;
    if (!timestampPresent && (now < signerNotBefore || now > signerNotAfter)) {
      throw new Error(`${fileName}: signer certificate is outside its validity window and no timestamp is present`);
    }

    const channel = channelForSetup(fileName);
    if (channel) setupCounts[channel] += 1;
    normalized.push({
      fileName,
      status,
      signerCommonName,
      thumbprint,
      signerNotBefore: signerNotBefore.toISOString(),
      signerNotAfter: signerNotAfter.toISOString(),
      timestampPresent,
      channel,
    });
  }

  for (const channel of required) {
    if (setupCounts[channel] === 0) throw new Error(`missing required ${channel} NSIS setup executable`);
    if (setupCounts[channel] > 1) throw new Error(`multiple ${channel} NSIS setup executables were found`);
  }

  return {
    records: normalized,
    setupCounts,
    requiredChannels: required,
  };
}

module.exports = {
  channelForSetup,
  validateWindowsSignatures,
};
