#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ISSUE_210_PLATFORMS = ["web", "electron"];
export const ISSUE_210_SCENARIOS = [
  "markdown-2.4mb",
  "tiptap-20000",
  "tiptap-50000",
  "list-batch-100",
  "media-100",
  "media-500",
  "code-100",
  "code-500",
  "switch-20-and-close",
];

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function normalizeAttachmentUrl(value) {
  try {
    const parsed = new URL(value, "http://localhost/");
    for (const key of ["exp", "sig", "scope"]) parsed.searchParams.delete(key);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(value || "");
  }
}

function validateLifecycleSnapshot(snapshot, label, failures) {
  if (!snapshot || typeof snapshot !== "object") {
    failures.push(`${label} is missing`);
    return false;
  }
  for (const field of ["workers", "nodeViews", "mediaRequests"]) {
    if (!finiteNonNegative(snapshot[field])) failures.push(`${label}.${field} is invalid`);
  }
  return ["workers", "nodeViews", "mediaRequests"].every((field) => finiteNonNegative(snapshot[field]));
}

export function validatePerformanceRun(run) {
  const failures = [];
  if (!run || typeof run !== "object") return ["run is missing"];
  if (!ISSUE_210_PLATFORMS.includes(run.platform)) failures.push("platform is invalid");
  if (!ISSUE_210_SCENARIOS.includes(run.scenario)) failures.push("scenario is invalid");
  if (!Array.isArray(run.inputLatencyMs) || run.inputLatencyMs.length === 0 || !run.inputLatencyMs.every(finiteNonNegative)) {
    failures.push("inputLatencyMs requires samples");
  }
  if (!Array.isArray(run.longTaskMs) || !run.longTaskMs.every(finiteNonNegative)) {
    failures.push("longTaskMs is invalid");
  }

  const p50 = percentile(Array.isArray(run.inputLatencyMs) ? run.inputLatencyMs.filter(finiteNonNegative) : [], 0.5);
  const p95 = percentile(Array.isArray(run.inputLatencyMs) ? run.inputLatencyMs.filter(finiteNonNegative) : [], 0.95);
  const longestTask = Array.isArray(run.longTaskMs) && run.longTaskMs.length > 0
    ? Math.max(...run.longTaskMs.filter(finiteNonNegative))
    : 0;
  if (p50 > 16) failures.push(`input p50 ${p50}ms exceeds 16ms`);
  if (p95 > 50) failures.push(`input p95 ${p95}ms exceeds 50ms`);
  if (longestTask > 200) failures.push(`longest task ${longestTask}ms exceeds 200ms`);
  if (run.longTaskObservationSupported !== true) failures.push("Long Task observation is unavailable");
  if (!finiteNonNegative(run.firstInteractiveMs)) failures.push("firstInteractiveMs is invalid");

  for (const field of [
    "peakDomNodes",
    "peakNodeViews",
    "heapBeforeBytes",
    "heapOpenedBytes",
    "heapScrolledBytes",
    "heapAfterBytes",
    "activeWorkersAfterClose",
    "activeNodeViewsAfterClose",
    "activeMediaRequestsAfterClose",
  ]) {
    if (!finiteNonNegative(run[field])) failures.push(`${field} is invalid`);
  }

  if (finiteNonNegative(run.heapBeforeBytes)) {
    const stages = [run.heapOpenedBytes, run.heapScrolledBytes, run.heapAfterBytes].filter(finiteNonNegative);
    const heapGrowth = Math.max(0, ...stages.map((bytes) => bytes - run.heapBeforeBytes));
    const allowance = Math.max(64 * 1024 * 1024, run.heapBeforeBytes * 0.2);
    if (heapGrowth > allowance) failures.push("heap growth exceeds allowance");
  }
  if (run.activeWorkersAfterClose !== 0) failures.push("workers remain active after close");
  if (run.activeNodeViewsAfterClose !== 0) failures.push("NodeViews remain active after close");
  if (run.activeMediaRequestsAfterClose !== 0) failures.push("media requests remain active after close");
  if (run.editorMode !== "monolithic" && run.editorMode !== "windowed") failures.push("editorMode is invalid");
  if (!Number.isInteger(run.sectionCount) || run.sectionCount < 1) failures.push("sectionCount is invalid");
  if (!Number.isInteger(run.peakMountedSections) || run.peakMountedSections < 1 || run.peakMountedSections > run.sectionCount) {
    failures.push("peakMountedSections is invalid");
  }

  if (run.scenario === "markdown-2.4mb" && run.markdownRenderMatches !== true) {
    failures.push("markdown segmented render mismatch");
  }

  if (run.scenario === "switch-20-and-close") {
    if (!Array.isArray(run.noteSwitchMs) || run.noteSwitchMs.length !== 20 || !run.noteSwitchMs.every(finiteNonNegative)) {
      failures.push("noteSwitchMs requires 20 samples");
    }
    const baselineValid = validateLifecycleSnapshot(run.lifecycleBaseline, "lifecycleBaseline", failures);
    const snapshotsValid = Array.isArray(run.lifecycleSnapshots)
      && run.lifecycleSnapshots.length === 20
      && run.lifecycleSnapshots.every((snapshot, index) => validateLifecycleSnapshot(snapshot, `lifecycleSnapshots[${index}]`, failures));
    if (!snapshotsValid) failures.push("lifecycleSnapshots requires 20 valid samples");
    if (baselineValid && snapshotsValid) {
      for (const field of ["workers", "nodeViews", "mediaRequests"]) {
        const baseline = run.lifecycleBaseline[field];
        const values = run.lifecycleSnapshots.map((snapshot) => snapshot[field]);
        if (values[values.length - 1] > baseline) failures.push(`${field} did not return to baseline`);
      }
    }
  }

  return failures;
}

function validateSaveSamples(snapshot, failures) {
  if (!Array.isArray(snapshot.saveSamples) || snapshot.saveSamples.length < 3) {
    failures.push("at least 3 auto-save stability samples are required");
    return;
  }
  snapshot.saveSamples.forEach((sample, index) => {
    const prefix = `saveSamples[${index}]`;
    if (!sample || typeof sample !== "object") {
      failures.push(`${prefix} is invalid`);
      return;
    }
    if (!Number.isInteger(sample.status) || sample.status < 200 || sample.status >= 300) {
      failures.push(`${prefix}.status is not successful`);
    }
    if (sample.instanceStable !== true) failures.push(`${prefix} remounted the editor`);
    if (sample.selectionStable !== true) failures.push(`${prefix} changed the selection`);
    if (!finiteNonNegative(Math.abs(sample.scrollDeltaPx))) failures.push(`${prefix}.scrollDeltaPx is missing`);
    else if (Math.abs(sample.scrollDeltaPx) > 2) failures.push(`${prefix} moved scroll by more than 2px`);
    if (!finiteNonNegative(sample.layoutShiftDelta)) failures.push(`${prefix}.layoutShiftDelta is invalid`);
    else if (sample.layoutShiftDelta > 0.01) failures.push(`${prefix} layout shift exceeds 0.01`);
  });
}

function validateMedia(snapshot, failures) {
  if (!Array.isArray(snapshot.mediaResources)) {
    failures.push("mediaResources is missing");
    return;
  }
  const first = snapshot.mediaResources.filter((item) => item?.phase === "first-open");
  const second = snapshot.mediaResources.filter((item) => item?.phase === "second-open");
  const video = snapshot.mediaResources.filter((item) => item?.phase === "video-seek");
  if (first.length === 0) failures.push("first-open media samples are missing");
  if (second.length === 0) failures.push("second-open media samples are missing");
  if (video.length === 0) failures.push("video-seek media samples are missing");

  const firstByUrl = new Map();
  for (const item of first) firstByUrl.set(normalizeAttachmentUrl(item.name), item);
  const repeated = second.filter((item) => firstByUrl.has(normalizeAttachmentUrl(item.name)));
  if (repeated.length === 0) failures.push("no attachment was observed in both opens");
  if (repeated.length > 0 && !repeated.some((item) => item.fromCache === true)) {
    failures.push("reopened attachment did not hit memory/disk cache");
  }

  const firstTransferred = first.reduce((sum, item) => sum + (finiteNonNegative(item.transferSize) ? item.transferSize : 0), 0);
  const secondTransferred = second.reduce((sum, item) => sum + (finiteNonNegative(item.transferSize) ? item.transferSize : 0), 0);
  if (firstTransferred > 0 && secondTransferred > Math.max(64 * 1024, firstTransferred * 0.25)) {
    failures.push("second-open media transfer exceeds cache budget");
  }
  if (!video.some((item) => item.responseStatus === 206)) {
    failures.push("video seek did not record a 206 Range response");
  }
}

function validatePerformanceMatrix(snapshot, failures) {
  if (!Array.isArray(snapshot.performanceRuns)) {
    failures.push("performanceRuns is missing");
    return;
  }
  const runs = new Map();
  for (const run of snapshot.performanceRuns) {
    if (run?.platform !== snapshot.platform) {
      failures.push(`performance run ${run?.scenario || "unknown"} platform mismatch`);
      continue;
    }
    if (runs.has(run.scenario)) failures.push(`duplicate performance run: ${run.scenario}`);
    runs.set(run.scenario, run);
  }
  for (const scenario of ISSUE_210_SCENARIOS) {
    const run = runs.get(scenario);
    if (!run) {
      failures.push(`missing performance scenario: ${scenario}`);
      continue;
    }
    for (const failure of validatePerformanceRun(run)) {
      failures.push(`${scenario}: ${failure}`);
    }
  }
}

export function validateIssue210Snapshot(snapshot) {
  const failures = [];
  if (!snapshot || typeof snapshot !== "object") return ["snapshot is missing"];
  if (snapshot.schemaVersion !== 1) failures.push("schemaVersion must be 1");
  if (!ISSUE_210_PLATFORMS.includes(snapshot.platform)) failures.push("platform must be web or electron");
  if (typeof snapshot.capturedAt !== "string" || Number.isNaN(Date.parse(snapshot.capturedAt))) {
    failures.push("capturedAt is invalid");
  }
  if (typeof snapshot.userAgent !== "string" || snapshot.userAgent.trim().length < 8) {
    failures.push("userAgent is missing");
  }
  validateSaveSamples(snapshot, failures);
  validateMedia(snapshot, failures);
  validatePerformanceMatrix(snapshot, failures);
  return failures;
}

export function validateIssue210Bundle(snapshots) {
  const failures = [];
  const byPlatform = new Map();
  for (const snapshot of snapshots) {
    if (snapshot?.platform && byPlatform.has(snapshot.platform)) {
      failures.push(`duplicate platform snapshot: ${snapshot.platform}`);
    } else if (snapshot?.platform) {
      byPlatform.set(snapshot.platform, snapshot);
    }
    for (const failure of validateIssue210Snapshot(snapshot)) {
      failures.push(`${snapshot?.platform || "unknown"}: ${failure}`);
    }
  }
  for (const platform of ISSUE_210_PLATFORMS) {
    if (!byPlatform.has(platform)) failures.push(`missing platform snapshot: ${platform}`);
  }
  return { passed: failures.length === 0, failures };
}

function runCli(argv) {
  if (argv.length === 0) {
    console.error("Usage: node scripts/validate-issue-210-signoff.mjs <web.json> <electron.json>");
    return 2;
  }
  const snapshots = [];
  for (const filename of argv) {
    const absolute = path.resolve(process.cwd(), filename);
    try {
      snapshots.push(JSON.parse(fs.readFileSync(absolute, "utf8")));
    } catch (error) {
      console.error(`Failed to read ${filename}: ${error instanceof Error ? error.message : error}`);
      return 2;
    }
  }
  const result = validateIssue210Bundle(snapshots);
  if (!result.passed) {
    console.error("Issue #210 performance sign-off failed:");
    for (const failure of result.failures) console.error(`- ${failure}`);
    return 1;
  }
  console.log("Issue #210 performance sign-off passed for Web and Electron.");
  return 0;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  process.exitCode = runCli(process.argv.slice(2));
}
