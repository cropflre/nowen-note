// Isolated E2E fixture: real HTTP, SQLite and React; deterministic GitHub boundary.
import { readFile } from "node:fs/promises";
import { Cloud } from "../../server/cloud";
import { expectedArtifacts, normalizeBuild } from "../../../../scripts/lib/release-cloud-contract.mjs";
import { root } from "../helpers";
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
class BrowserCloudGitHub extends FakeGitHub {
  cloudRuns: any[] = [];
  buildInput: any;
  override async resolve() { return "a".repeat(40); }
  override async content(path: string) { return readFile(join(root, path), "utf8"); }
  override async request(path: string, method = "GET", body?: any) {
    if (method === "POST" && path.endsWith("/dispatches")) {
      this.buildInput = normalizeBuild(body.inputs);
      this.cloudRuns.push({ id: 501, display_title: `Release build ${body.inputs.request_id}`, head_sha: "a".repeat(40), path: ".github/workflows/release-build.yml" });
    }
    return {};
  }
  override async list() { return this.cloudRuns; }
  override async run() { return { id:501,run_attempt:1,status:"completed",conclusion:"success",head_sha:"a".repeat(40),path:".github/workflows/release-build.yml" }; }
  override async jobs() { return [{id:601,name:"Build Linux",status:"completed",conclusion:"success",steps:[{name:"Package",status:"completed",conclusion:"success"}]}]; }
  override async artifacts() { return [...expectedArtifacts(this.buildInput),"release-manifest"].map((name,index)=>({id:index+1,name,size:1,digest:`sha256:${"b".repeat(64)}`,expired:false,verification:"not_downloaded" as const})); }
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
const cloud = new Cloud(store, new BrowserCloudGitHub(), root);
const server = createApp(engine, {
  cloud,
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
