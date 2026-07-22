import { describe, expect, it } from "vitest";
import {
  describeMissingUpdateAsset,
  isMissingUpdateAssetFailure,
} from "@/lib/updateAssetFailure";

describe("updateAssetFailure", () => {
  it("classifies a download-stage 404 as a missing release asset", () => {
    expect(isMissingUpdateAssetFailure({
      status: "error",
      phase: "error",
      errorStage: "download",
      message: "Cannot download: HTTP status 404 Not Found",
      currentVersion: "1.4.1",
      version: "1.4.2",
    })).toBe(true);
  });

  it("does not classify ordinary network or check errors as missing assets", () => {
    expect(isMissingUpdateAssetFailure({
      status: "error",
      phase: "error",
      errorStage: "check",
      message: "net::ERR_CONNECTION_RESET",
    })).toBe(false);
    expect(isMissingUpdateAssetFailure({
      status: "error",
      phase: "error",
      errorStage: "download",
      message: "net::ERR_CONNECTION_RESET",
    })).toBe(false);
  });

  it("builds a version-aware manual download explanation", () => {
    const message = describeMissingUpdateAsset({
      status: "error",
      phase: "error",
      errorStage: "download",
      currentVersion: "1.4.1",
      version: "1.4.2",
    });
    expect(message).toContain("v1.4.2");
    expect(message).toContain("v1.4.1");
  });
});
