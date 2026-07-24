import assert from "node:assert/strict";
import test from "node:test";
import {
  ISSUE_210_SCENARIOS,
  validateIssue210Bundle,
  validateIssue210Snapshot,
} from "../validate-issue-210-signoff.mjs";

function performanceRun(platform, scenario) {
  const lifecycle = { workers: 0, nodeViews: 0, mediaRequests: 0 };
  return {
    platform,
    scenario,
    inputLatencyMs: [5, 8, 12, 15],
    longTaskMs: [25, 40],
    longTaskObservationSupported: true,
    firstInteractiveMs: 120,
    noteSwitchMs: scenario === "switch-20-and-close" ? Array(20).fill(18) : [],
    peakDomNodes: 1200,
    peakNodeViews: 40,
    heapBeforeBytes: 100_000_000,
    heapOpenedBytes: 110_000_000,
    heapScrolledBytes: 112_000_000,
    heapAfterBytes: 105_000_000,
    activeWorkersAfterClose: 0,
    activeNodeViewsAfterClose: 0,
    activeMediaRequestsAfterClose: 0,
    lifecycleBaseline: scenario === "switch-20-and-close" ? lifecycle : undefined,
    lifecycleSnapshots: scenario === "switch-20-and-close"
      ? Array.from({ length: 20 }, () => ({ ...lifecycle }))
      : [],
    markdownRenderMatches: scenario === "markdown-2.4mb" ? true : undefined,
    editorMode: "windowed",
    sectionCount: 8,
    peakMountedSections: 3,
  };
}

function saveSample() {
  const editor = {
    editorInstanceId: "editor-1",
    noteId: "note-1",
    selection: {
      anchorPath: "0.0",
      anchorOffset: 4,
      focusPath: "0.0",
      focusOffset: 4,
    },
    scrollTop: 120,
  };
  return {
    url: "/api/notes/note-1",
    method: "PUT",
    status: 200,
    startedAt: 1,
    durationMs: 30,
    before: editor,
    after: { ...editor },
    instanceStable: true,
    selectionStable: true,
    scrollDeltaPx: 0,
    layoutShiftDelta: 0,
  };
}

function snapshot(platform) {
  return {
    schemaVersion: 1,
    platform,
    capturedAt: "2026-07-25T00:00:00.000Z",
    userAgent: platform === "electron" ? "Nowen Electron Chrome" : "Chrome Web Browser",
    layoutShiftTotal: 0,
    saveSamples: [saveSample(), saveSample(), saveSample()],
    mediaResources: [
      {
        phase: "first-open",
        name: "https://example.test/api/attachments/asset-1?exp=1&sig=first&scope=read",
        initiatorType: "img",
        startTime: 1,
        durationMs: 30,
        transferSize: 100_000,
        encodedBodySize: 99_000,
        decodedBodySize: 99_000,
        responseStatus: 200,
        fromCache: false,
      },
      {
        phase: "second-open",
        name: "https://example.test/api/attachments/asset-1?exp=2&sig=second&scope=read",
        initiatorType: "img",
        startTime: 2,
        durationMs: 2,
        transferSize: 0,
        encodedBodySize: 99_000,
        decodedBodySize: 99_000,
        responseStatus: 200,
        fromCache: true,
      },
      {
        phase: "video-seek",
        name: "https://example.test/api/attachments/video-1?inline=1",
        initiatorType: "video",
        startTime: 3,
        durationMs: 10,
        transferSize: 4096,
        encodedBodySize: 4000,
        decodedBodySize: 4000,
        responseStatus: 206,
        fromCache: false,
      },
    ],
    performanceRuns: ISSUE_210_SCENARIOS.map((scenario) => performanceRun(platform, scenario)),
  };
}

test("accepts complete Web and Electron sign-off evidence", () => {
  const result = validateIssue210Bundle([snapshot("web"), snapshot("electron")]);
  assert.equal(result.passed, true, result.failures.join("\n"));
});

test("rejects editor remount, selection movement and scroll jumps", () => {
  const value = snapshot("web");
  value.saveSamples[0].instanceStable = false;
  value.saveSamples[1].selectionStable = false;
  value.saveSamples[2].scrollDeltaPx = 8;
  const failures = validateIssue210Snapshot(value).join("\n");
  assert.match(failures, /remounted the editor/);
  assert.match(failures, /changed the selection/);
  assert.match(failures, /moved scroll by more than 2px/);
});

test("rejects missing selection and scroll evidence", () => {
  const value = snapshot("web");
  value.saveSamples[0].before.selection = null;
  value.saveSamples[1].scrollDeltaPx = null;
  const failures = validateIssue210Snapshot(value).join("\n");
  assert.match(failures, /selection evidence is missing/);
  assert.match(failures, /scrollDeltaPx is missing/);
});

test("rejects missing cache and Range evidence", () => {
  const value = snapshot("electron");
  const second = value.mediaResources.find((item) => item.phase === "second-open");
  second.fromCache = false;
  second.transferSize = 100_000;
  const video = value.mediaResources.find((item) => item.phase === "video-seek");
  video.responseStatus = 200;
  const failures = validateIssue210Snapshot(value).join("\n");
  assert.match(failures, /did not hit memory\/disk cache/);
  assert.match(failures, /206 Range response/);
});

test("requires both platform snapshots and every performance scenario", () => {
  const web = snapshot("web");
  web.performanceRuns.pop();
  const result = validateIssue210Bundle([web]);
  assert.equal(result.passed, false);
  assert.match(result.failures.join("\n"), /missing platform snapshot: electron/);
  assert.match(result.failures.join("\n"), /missing performance scenario/);
});
