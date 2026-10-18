// Isolated candidate staging. No GitHub API, Tag, Draft or publishing side effects.
// Both the artifact files and their evidence remain explicitly non-release candidates.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { verifyFormalDirectory } from "./release-center-formal-assets.mjs";

const require = createRequire(import.meta.url);
const { requiredDebugReleaseAssets } = require("./lib/release-platform-assets.cjs");

export function candidateInput({ platform, sha, version, requestId, runId, runAttempt }) {
  if (!["windows", "macos", "linux"].includes(platform) ||
      !/^[a-f0-9]{40}$/.test(sha || "") ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version || "") ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId || "") ||
      !Number.isSafeInteger(Number(runId)) || Number(runId) <= 0 ||
      !Number.isSafeInteger(Number(runAttempt)) || Number(runAttempt) <= 0)
    throw Error("Invalid candidate source / version / request identity");
  return { platform, sha, version, requestId, runId: Number(runId), runAttempt: Number(runAttempt) };
}

function requiredFiles(platform, version) {
  const result = [...requiredDebugReleaseAssets(platform, version)];
  if (platform === "windows") result.push(
    "Nowen-Note-Lite-" + version + "-setup.exe",
    "Nowen-Note-Lite-" + version + "-portable.exe",
    "Nowen-Note-Lite-" + version + "-setup.exe.blockmap",
    "latest-lite.yml",
  );
  return result;
}

async function requireRegular(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0)
    throw Error("Candidate source is not a nonempty regular file: " + path);
}

export async function stageCandidate(root, input) {
  const identity = candidateInput(input);
  const { platform, version } = identity;
  const outRoot = resolve(root, "rc-candidate");
  await mkdir(outRoot, { recursive: true });
  const stage = join(outRoot, platform);
  await mkdir(stage); // Never clobber another run or an existing staging directory.
  const assetsDir = join(stage, "assets");
  await mkdir(assetsDir);
  try {
    const required = requiredFiles(platform, version);
    const sources = new Map();
    for (const name of required)
      sources.set(name, join(root, platform === "windows" && name.startsWith("Nowen-Note-Lite-") ||
        platform === "windows" && name === "latest-lite.yml" ? "dist-electron-lite" : "dist-electron", name));
    // The macOS packager may create separate blockmaps for update ZIPs.
    if (platform === "macos") {
      for (const name of required.filter((value) => /\.(?:dmg|zip)$/.test(value))) {
        const blockmap = name + ".blockmap";
        try {
          await requireRegular(join(root, "dist-electron", blockmap));
          sources.set(blockmap, join(root, "dist-electron", blockmap));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }
    for (const [name, source] of sources) {
      await requireRegular(source);
      await copyFile(source, join(assetsDir, name));
    }
    const report = await verifyFormalDirectory(assetsDir, { platform, version });
    const fileEvidence = report.files.map(({ name, architecture, size, sha256, updaterMetadata }) =>
      ({ name, architecture, size, sha256, updaterMetadata }));
    const evidence = {
      schema: 1,
      purpose: "candidate-build-only",
      releaseEligible: false,
      signed: false,
      approved: false,
      source: {
        repository: "cropflre/nowen-note",
        sha: identity.sha,
        version: identity.version,
        requestId: identity.requestId,
        runId: identity.runId,
        runAttempt: identity.runAttempt,
        platform: identity.platform,
      },
      updaterVerification: report.updaterVerification,
      files: fileEvidence,
      filesDigest: "sha256:" + createHash("sha256").update(JSON.stringify(fileEvidence)).digest("hex"),
    };
    await writeFile(join(stage, "candidate-evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return evidence;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || "")).href) {
  const evidence = await stageCandidate(process.cwd(), {
    platform: process.env.RC_PLATFORM,
    sha: process.env.RC_SHA,
    version: process.env.RC_VERSION,
    requestId: process.env.RC_REQUEST_ID,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  console.log("Candidate-only stage verified: " + evidence.source.platform + ", " + evidence.files.length + " files");
}
