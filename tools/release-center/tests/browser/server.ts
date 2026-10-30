// Isolated E2E fixture: real HTTP, SQLite and React; deterministic GitHub boundary.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../../server/store";
import { Engine } from "../../server/engine";
import { createApp } from "../../server/app";
import { validateInput } from "../../server/planner";
import { FakeGitHub, FakePlanner, makePlan } from "../helpers";
import { seedDebugArtifacts } from "../verification-fixture";
import { Channels } from "../../server/channels";
import { ChannelGitHub, ChannelProvider, storeToken } from "../channels-fixture";

class BrowserPlanner extends FakePlanner {
  override async create(raw?: any) {
    if (!raw) return this.nextPlan;
    const value = validateInput(raw);
    return makePlan({
      ...value,
      ready: value.version !== "9.9.9",
      debugReady: false,
      checks: [
        { name: "固定 Commit", status: "pass", detail: "a".repeat(40) },
        {
          name: "版本文件一致性",
          status: value.version === "9.9.9" ? "fail" : "pass",
          detail:
            value.version === "9.9.9"
              ? "期望 9.9.9；实际 1.5.2"
              : "Root / backend / Android / lockfile 均为 1.5.2",
        },
        {
          name: "正式发布审批",
          status: "unknown",
          detail: "Phase 1 不支持正式发布",
        },
      ],
    });
  }
}
const directory = mkdtempSync(join(tmpdir(), "nowen-rc-browser-"));
const store = new Store(join(directory, "center.sqlite"));
const github = new FakeGitHub();
await seedDebugArtifacts(
  store,
  github,
  makePlan({
    platforms: ["windows"],
    notes: "Browser fixture only: not an actual GitHub build",
  }),
);
const engine = new Engine(store, new BrowserPlanner(github, makePlan()));
engine.start();
const server = createApp(engine, {
  dist: fileURLToPath(new URL("../../dist", import.meta.url)),
  channels: new Channels(store, new ChannelGitHub(), { storeToken }, new ChannelProvider().transport),
});
server.listen(4328, "127.0.0.1");
async function stop() {
  server.closeAllConnections();
  server.close();
  await engine.stop();
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
