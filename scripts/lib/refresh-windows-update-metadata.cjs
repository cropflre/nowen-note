const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  assetNameFromUrl,
  parseUpdateMetadata,
  sha512File,
  validateLocalMetadataFiles,
} = require("./update-metadata-validator.cjs");

const CHANNELS = new Set(["full", "lite"]);

function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/, "");
}

function stableSetupName(channel, version) {
  return channel === "lite"
    ? `Nowen-Note-Lite-${version}-setup.exe`
    : `Nowen-Note-${version}-setup.exe`;
}

function expectedMetadataName(channel) {
  return channel === "lite" ? "latest-lite.yml" : "latest.yml";
}

function listChannelSetupCandidates(assetDir, channel) {
  const entries = fs.readdirSync(assetDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      if (channel === "lite") return /^Nowen-Note-Lite-.+-setup\.exe$/.test(name);
      return /^Nowen-Note-.+-setup\.exe$/.test(name) && !/^Nowen-Note-Lite-/.test(name);
    })
    .sort();
}

function rewriteIntegrityFields(source, { oldSha512, newSha512, oldSize, newSize }) {
  if (!oldSha512 || !newSha512) throw new Error("sha512 values are required");
  if (!Number.isFinite(Number(oldSize)) || !Number.isFinite(Number(newSize))) {
    throw new Error("size values must be finite numbers");
  }

  const shaPattern = /^(\s*)sha512:\s*([^\r\n]+?)\s*$/gm;
  const sizePattern = /^(\s+)size:\s*([^\r\n]+?)\s*$/gm;
  const shaMatches = Array.from(String(source).matchAll(shaPattern));
  const sizeMatches = Array.from(String(source).matchAll(sizePattern));

  if (shaMatches.length !== 2) {
    throw new Error(`expected exactly 2 sha512 fields, found ${shaMatches.length}`);
  }
  if (sizeMatches.length !== 1) {
    throw new Error(`expected exactly 1 indented size field, found ${sizeMatches.length}`);
  }

  for (const match of shaMatches) {
    if (match[2].trim() !== String(oldSha512)) {
      throw new Error("metadata sha512 fields do not match the pre-signing sha512");
    }
  }
  if (sizeMatches[0][2].trim() !== String(oldSize)) {
    throw new Error("metadata size field does not match the pre-signing size");
  }

  const withSha = String(source).replace(
    shaPattern,
    (_match, indent) => `${indent}sha512: ${newSha512}`,
  );
  return withSha.replace(
    sizePattern,
    (_match, indent) => `${indent}size: ${newSize}`,
  );
}

function rebuildBlockmap({ executablePath, blockmapPath }) {
  const executable = path.resolve(executablePath);
  const output = path.resolve(blockmapPath || `${executable}.blockmap`);
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    throw new Error(`Windows updater executable does not exist: ${executable}`);
  }

  let appBuilderPath;
  try {
    ({ appBuilderPath } = require("app-builder-bin"));
  } catch (error) {
    throw new Error(`app-builder-bin is required to rebuild blockmap: ${error.message}`);
  }
  if (!appBuilderPath) throw new Error("app-builder-bin did not expose appBuilderPath");

  const result = spawnSync(
    appBuilderPath,
    ["blockmap", `--input=${executable}`, `--output=${output}`, "--compression=gzip"],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`blockmap rebuild failed (${result.status})${detail ? `: ${detail}` : ""}`);
  }
  if (!fs.existsSync(output) || fs.statSync(output).size <= 0) {
    throw new Error(`blockmap rebuild produced no output: ${output}`);
  }
  return output;
}

function refreshWindowsUpdateMetadata({ metadataPath, assetDir, channel, expectedVersion }) {
  if (!CHANNELS.has(channel)) throw new Error(`channel must be 'full' or 'lite', got '${channel}'`);
  const version = normalizeVersion(expectedVersion);
  if (!version) throw new Error("expectedVersion is required");

  const metadataFile = path.resolve(metadataPath);
  const assets = path.resolve(assetDir);
  if (!fs.existsSync(metadataFile) || !fs.statSync(metadataFile).isFile()) {
    throw new Error(`metadata file does not exist: ${metadataFile}`);
  }
  if (!fs.existsSync(assets) || !fs.statSync(assets).isDirectory()) {
    throw new Error(`asset directory does not exist: ${assets}`);
  }
  if (path.basename(metadataFile) !== expectedMetadataName(channel)) {
    throw new Error(`${channel} channel requires ${expectedMetadataName(channel)}`);
  }

  const source = fs.readFileSync(metadataFile, "utf8");
  const metadata = parseUpdateMetadata(source, path.basename(metadataFile));
  if (normalizeVersion(metadata.version) !== version) {
    throw new Error(`metadata version ${metadata.version || "<empty>"} does not match ${version}`);
  }
  if (!Array.isArray(metadata.files) || metadata.files.length !== 1) {
    throw new Error(`metadata must reference exactly one updater executable, found ${metadata.files?.length || 0}`);
  }

  const expectedSetup = stableSetupName(channel, version);
  const fileName = assetNameFromUrl(metadata.files[0].url);
  const topLevelName = assetNameFromUrl(metadata.path);
  if (fileName !== expectedSetup || topLevelName !== expectedSetup) {
    throw new Error(`${channel} metadata must reference exactly ${expectedSetup}`);
  }

  const candidates = listChannelSetupCandidates(assets, channel);
  if (candidates.length !== 1 || candidates[0] !== expectedSetup) {
    throw new Error(
      `${channel} channel requires exactly one setup candidate '${expectedSetup}', found: ${candidates.join(", ") || "none"}`,
    );
  }

  const executablePath = path.join(assets, expectedSetup);
  if (!fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile()) {
    throw new Error(`signed updater executable does not exist: ${expectedSetup}`);
  }
  if (!metadata.sha512 || !metadata.files[0].sha512) {
    throw new Error("metadata sha512 fields are missing");
  }
  if (metadata.sha512 !== metadata.files[0].sha512) {
    throw new Error("top-level and files[] sha512 values differ before refresh");
  }
  if (!Number.isFinite(metadata.files[0].size) || metadata.files[0].size <= 0) {
    throw new Error("metadata files[0].size is invalid");
  }

  const stat = fs.statSync(executablePath);
  const newSha512 = sha512File(executablePath);
  const newSize = stat.size;
  const rewritten = rewriteIntegrityFields(source, {
    oldSha512: metadata.sha512,
    newSha512,
    oldSize: metadata.files[0].size,
    newSize,
  });

  const blockmapPath = rebuildBlockmap({
    executablePath,
    blockmapPath: `${executablePath}.blockmap`,
  });
  fs.writeFileSync(metadataFile, rewritten, "utf8");

  validateLocalMetadataFiles({
    metadataPaths: [metadataFile],
    assetDir: assets,
    expectedVersion: version,
    requireMetadata: true,
  });

  return {
    channel,
    metadataPath: metadataFile,
    executablePath,
    blockmapPath,
    size: newSize,
    sha512: newSha512,
  };
}

module.exports = {
  rebuildBlockmap,
  refreshWindowsUpdateMetadata,
  rewriteIntegrityFields,
};
