const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const UPDATE_METADATA_NAME_RE = /^(?:latest(?:-[a-z0-9._-]+)?|lite(?:-[a-z0-9._-]+)?)\.ya?ml$/i;
const SAFE_ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BLOCKMAP_EXT_RE = /\.(?:exe|zip|appimage)$/i;

function isUpdateMetadataName(name) {
  return UPDATE_METADATA_NAME_RE.test(path.basename(String(name || "")));
}

function unquoteYamlScalar(raw) {
  const text = String(raw ?? "").trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function parseUpdateMetadata(text, source = "latest.yml") {
  const metadata = {
    source,
    version: "",
    path: "",
    sha512: "",
    files: [],
  };
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  let inFiles = false;
  let current = null;

  for (const rawLine of lines) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length || 0;
    const line = rawLine.trim();

    if (indent === 0) {
      current = null;
      if (/^files\s*:\s*$/.test(line)) {
        inFiles = true;
        continue;
      }
      inFiles = false;
      const top = line.match(/^(version|path|sha512)\s*:\s*(.*)$/);
      if (top) metadata[top[1]] = unquoteYamlScalar(top[2]);
      continue;
    }

    if (!inFiles) continue;
    const item = line.match(/^-\s+url\s*:\s*(.*)$/);
    if (item) {
      current = { url: unquoteYamlScalar(item[1]), sha512: "", size: null };
      metadata.files.push(current);
      continue;
    }
    if (!current) continue;
    const property = line.match(/^(url|sha512|size)\s*:\s*(.*)$/);
    if (!property) continue;
    if (property[1] === "size") {
      const parsed = Number(unquoteYamlScalar(property[2]));
      current.size = Number.isFinite(parsed) ? parsed : null;
    } else {
      current[property[1]] = unquoteYamlScalar(property[2]);
    }
  }

  return metadata;
}

function assetNameFromUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  let pathname = value;
  try {
    pathname = new URL(value).pathname;
  } catch {
    pathname = value.split(/[?#]/, 1)[0];
  }
  const encodedName = pathname.replace(/\\/g, "/").split("/").pop() || "";
  try {
    return decodeURIComponent(encodedName);
  } catch {
    return encodedName;
  }
}

function sha512File(filePath) {
  return crypto.createHash("sha512").update(fs.readFileSync(filePath)).digest("base64");
}

function assertSafeAssetName(assetName, source) {
  if (!assetName) throw new Error(`${source}: update metadata contains an empty asset URL`);
  if (!SAFE_ASSET_NAME_RE.test(assetName)) {
    throw new Error(`${source}: unsafe release asset name '${assetName}'. Use only letters, numbers, dot, underscore and hyphen.`);
  }
  if (/portable/i.test(assetName)) {
    throw new Error(`${source}: portable asset '${assetName}' must not be referenced by auto-update metadata`);
  }
}

function assertChannelIsolation(metadataName, assetName) {
  const metadataIsLite = /lite/i.test(path.basename(metadataName));
  const assetIsLite = /(?:^|[-_.])lite(?:[-_.]|$)/i.test(assetName);
  if (metadataIsLite && !assetIsLite) throw new Error(`${metadataName}: lite metadata references full asset '${assetName}'`);
  if (!metadataIsLite && assetIsLite) throw new Error(`${metadataName}: full metadata references lite asset '${assetName}'`);
}

function validateMetadataFile(metadataPath, options) {
  const expectedVersion = String(options?.expectedVersion || "").replace(/^v/, "");
  const assetDir = path.resolve(options?.assetDir || path.dirname(metadataPath));
  const metadataName = path.basename(metadataPath);
  const metadata = parseUpdateMetadata(fs.readFileSync(metadataPath, "utf8"), metadataName);
  const errors = [];
  const checkedAssets = [];

  if (!metadata.version) errors.push(`${metadataName}: missing version`);
  if (expectedVersion && metadata.version.replace(/^v/, "") !== expectedVersion) {
    errors.push(`${metadataName}: version ${metadata.version || "<empty>"} does not match ${expectedVersion}`);
  }
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) errors.push(`${metadataName}: files[] is empty`);
  if (!metadata.path) errors.push(`${metadataName}: missing top-level path`);
  if (!metadata.sha512) errors.push(`${metadataName}: missing top-level sha512`);

  const seen = new Set();
  for (const file of metadata.files) {
    const assetName = assetNameFromUrl(file.url);
    try {
      assertSafeAssetName(assetName, metadataName);
      assertChannelIsolation(metadataName, assetName);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    if (seen.has(assetName)) {
      errors.push(`${metadataName}: duplicate files[] entry '${assetName}'`);
      continue;
    }
    seen.add(assetName);

    const localPath = path.join(assetDir, assetName);
    if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
      errors.push(`${metadataName}: referenced asset does not exist: ${assetName}`);
      continue;
    }

    const stat = fs.statSync(localPath);
    if (!Number.isFinite(file.size) || file.size <= 0) errors.push(`${metadataName}: ${assetName} is missing a valid size`);
    else if (stat.size !== file.size) errors.push(`${metadataName}: ${assetName} size mismatch (metadata=${file.size}, actual=${stat.size})`);

    if (!file.sha512) errors.push(`${metadataName}: ${assetName} is missing sha512`);
    else if (sha512File(localPath) !== file.sha512) errors.push(`${metadataName}: ${assetName} sha512 mismatch`);

    if (BLOCKMAP_EXT_RE.test(assetName)) {
      const blockmapPath = `${localPath}.blockmap`;
      if (!fs.existsSync(blockmapPath) || !fs.statSync(blockmapPath).isFile() || fs.statSync(blockmapPath).size <= 0) {
        errors.push(`${metadataName}: required blockmap does not exist: ${assetName}.blockmap`);
      }
    }
    checkedAssets.push({ name: assetName, path: localPath, size: stat.size });
  }

  if (metadata.path) {
    const selectedName = assetNameFromUrl(metadata.path);
    if (!seen.has(selectedName)) errors.push(`${metadataName}: top-level path '${selectedName}' is not present in files[]`);
    else if (metadata.sha512) {
      const selected = metadata.files.find((file) => assetNameFromUrl(file.url) === selectedName);
      if (selected?.sha512 && selected.sha512 !== metadata.sha512) {
        errors.push(`${metadataName}: top-level sha512 does not match files[] for ${selectedName}`);
      }
    }
  }

  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { metadataPath, metadata, checkedAssets };
}

function discoverMetadataFiles(directory, expectedVersion = "") {
  const dir = path.resolve(directory);
  if (!fs.existsSync(dir)) return [];
  const matches = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !isUpdateMetadataName(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    if (!expectedVersion) {
      matches.push(filePath);
      continue;
    }
    try {
      const metadata = parseUpdateMetadata(fs.readFileSync(filePath, "utf8"), entry.name);
      if (metadata.version.replace(/^v/, "") === String(expectedVersion).replace(/^v/, "")) matches.push(filePath);
    } catch {
      // Explicit validation reports malformed current metadata.
    }
  }
  return matches.sort((a, b) => a.localeCompare(b));
}

function validateLocalMetadataFiles(options) {
  const metadataPaths = Array.from(new Set((options?.metadataPaths || []).map((value) => path.resolve(value))));
  const requireMetadata = options?.requireMetadata !== false;
  if (metadataPaths.length === 0) {
    if (requireMetadata) throw new Error("No electron-updater metadata was generated for this release target");
    return { metadataFiles: [], assets: [] };
  }

  const reports = metadataPaths.map((metadataPath) => validateMetadataFile(metadataPath, options));
  const assets = new Map();
  for (const report of reports) for (const asset of report.checkedAssets) assets.set(asset.name, asset);
  return {
    metadataFiles: reports.map((report) => path.basename(report.metadataPath)),
    assets: Array.from(assets.values()),
  };
}

function verifyLocalDirectory(options) {
  const directory = path.resolve(options?.directory || ".");
  const metadataPaths = options?.metadataPaths?.length
    ? options.metadataPaths
    : discoverMetadataFiles(directory, options?.expectedVersion || "");
  return validateLocalMetadataFiles({ ...options, metadataPaths, assetDir: options?.assetDir || directory });
}

module.exports = {
  UPDATE_METADATA_NAME_RE,
  assetNameFromUrl,
  discoverMetadataFiles,
  isUpdateMetadataName,
  parseUpdateMetadata,
  sha512File,
  validateLocalMetadataFiles,
  validateMetadataFile,
  verifyLocalDirectory,
};
