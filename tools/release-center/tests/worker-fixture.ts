// Subprocess crash/restart acceptance driver. No network or external mutation.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { Engine } from "../server/engine.ts";
import { FakeGitHub, FakePlanner, makePlan } from "./helpers.ts";
const [directory, mode] = process.argv.slice(2);
const store = new Store(join(directory, "center.sqlite"));
const github = new FakeGitHub();
const plan = store.tasks(true)[0]?.plan || makePlan();
github.dispatch = async () => {
  writeFileSync(join(directory, "dispatch-count"), "1");
  process.exit(77); // Simulate a service crash after sending, before receiving a response.
};
if (mode === "recover") github.found = { id: 101, head_sha: plan.workflowSha };
const engine = new Engine(store, new FakePlanner(github, plan));
engine.claim();
if (mode === "crash") {
  store.savePlan(plan);
  engine.submit({
    planId: plan.id,
    key: "subprocess-idempotency-key",
    mode: "debug",
    confirmDebug: true,
  });
}
await engine.tick();
console.log(
  JSON.stringify({
    task: store.tasks(true)[0],
    dispatchCount: readFileSync(join(directory, "dispatch-count"), "utf8"),
  }),
);
await engine.stop();
store.close();
