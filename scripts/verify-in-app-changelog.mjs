#!/usr/bin/env node
/**
 * Ensures the in-app What's New modal cannot show stale or raw git commit
 * messages after a release. Curated data is authoritative; changelog.json
 * remains a reproducible Vite public asset.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "docs/releases/in-app-changelog.json");
const targetPath = path.join(root, "frontend/public/changelog.json");
const pkgPath = path.join(root, "package.json");

const semver = /^\d+\.\d+\.\d+$/;
const shaInParentheses = /\([a-f0-9]{7,40}\)/i;

function compareSemver(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

export function validateInAppChangelog(data, appVersion) {
  if (!semver.test(appVersion)) throw Error("Application package version must be stable semver");
  if (!data || !Number.isFinite(Date.parse(data.generatedAt)) || !Array.isArray(data.entries)) {
    throw Error("Malformed curated in-app changelog");
  }
  if (data.entries.length === 0 || data.entries.length > 10) {
    throw Error("In-app changelog must contain 1 to 10 curated entries");
  }
  if (data.entries[0].version !== appVersion) {
    throw Error(`In-app changelog stale: latest ${data.entries[0].version} does not match application ${appVersion}`);
  }
  const versions = new Set();
  let previous;
  for (const item of data.entries) {
    if (!item || typeof item.version !== "string" || !semver.test(item.version)) {
      throw Error("Invalid changelog version");
    }
    if (versions.has(item.version) || (previous && compareSemver(previous, item.version) <= 0)) {
      throw Error("Changelog versions must be unique and strictly newest first");
    }
    if (typeof item.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) ||
        new Date(item.date + "T00:00:00Z").toISOString().slice(0, 10) !== item.date) {
      throw Error("Invalid release date: " + item.version);
    }
    if (typeof item.body !== "string" || item.body.length < 40 ||
        item.body.length > 4000 || !item.body.includes("### ")) {
      throw Error("Missing or excessively long curated notes: " + item.version);
    }
    if (shaInParentheses.test(item.body)) {
      throw Error("Raw commit hashes must not be displayed in the in-app changelog: " + item.version);
    }
    versions.add(item.version);
    previous = item.version;
  }
  return data;
}

export function verifyInAppChangelog() {
  const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  const source = validateInAppChangelog(JSON.parse(readFileSync(sourcePath, "utf8")), version);
  const built = validateInAppChangelog(JSON.parse(readFileSync(targetPath, "utf8")), version);
  if (JSON.stringify(source) !== JSON.stringify(built)) {
    throw Error("Frontend changelog.json differs from curated release notes; regenerate before building");
  }
  return { version, entries: built.entries.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyInAppChangelog();
    console.log(`[changelog] v${result.version}: ${result.entries} curated entries verified`);
  } catch (error) {
    console.error("[changelog] " + (error?.message || error));
    process.exitCode = 1;
  }
}
