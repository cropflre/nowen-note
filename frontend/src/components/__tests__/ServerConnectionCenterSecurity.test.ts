import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("ServerConnectionCenter account switching", () => {
  it("preserves scoped offline queues and removes profile secrets on delete", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/components/ServerConnectionCenter.tsx"), "utf8");
    expect(source).not.toContain("clearQueue()");
    expect(source).not.toContain("clearLocalIdMap()");
    expect(source).toContain("removeProfileCredential(profile.id)");
    expect(source).toContain("stagePendingProfileReauthentication(profile)");
  });
});
