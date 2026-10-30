import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import type { Plan, PlanInput } from "../shared.ts";
import { GitHub } from "../server/github.ts";
import { Planner } from "../server/planner.ts";
import { Store } from "../server/store.ts";
import { Engine } from "../server/engine.ts";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const input: PlanInput = {
  branch: "release/v1.5.2",
  version: "1.5.2",
  channel: "stable",
  platforms: ["windows", "linux"],
  notes: "Test candidate",
};
export function makePlan(extra: Partial<Plan> = {}): Plan {
  return {
    ...input,
    id: randomUUID(),
    sha: "a".repeat(40),
    workflowSha: "b".repeat(40),
    workflowRef: "release/v1.5.2",
    createdAt: new Date().toISOString(),
    checks: [{ name: "version", status: "pass", detail: "1.5.2" }],
    ready: true,
    debugReady: true,
    effects: ["Debug artifacts only"],
    ...extra,
  };
}
export class FakeGitHub extends GitHub {
  dispatchCount = 0;
  cancelCount = 0;
  found: any;
  remote: any = { id: 101, status: "in_progress", conclusion: null };
  remoteJobs: any[] = [];
  remoteArtifacts: any[] = [];
  dispatchError?: Error;
  pollError?: Error;
  constructor() {
    super("ghp_fixture_secret");
  }
  override async dispatch() {
    this.dispatchCount++;
    if (this.dispatchError) throw this.dispatchError;
  }
  override async findRun() {
    if (this.pollError) throw this.pollError;
    return this.found;
  }
  override async run() {
    return this.remote;
  }
  override async jobs() {
    return this.remoteJobs;
  }
  override async artifacts() {
    return this.remoteArtifacts;
  }
  override async cancel() {
    this.cancelCount++;
  }
  override async jobLog() {
    return "Authorization: Bearer ghp_fixture_secret\npassword=super-secret\nBuild finished";
  }
}
export class FakePlanner extends Planner {
  nextPlan: Plan;
  blocker?: Promise<void>;
  constructor(github: GitHub, plan: Plan) {
    super(root, github, "release/v1.5.2", true);
    this.nextPlan = plan;
  }
  override async create() {
    await this.blocker;
    return { ...this.nextPlan };
  }
  override async overview() {
    return {
      repo: "cropflre/nowen-note",
      branch: "release/v1.5.2",
      localSha: "a".repeat(40),
      localVersion: "1.5.2",
      dirty: false,
      tokenConfigured: true,
      debugEnabled: true,
      releases: [],
      branches: ["release/v1.5.2"],
      runs: [],
    };
  }
}
export function fixture(
  t: TestContext,
  options: { now?: () => number; timeoutMs?: number; plan?: Plan } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "nowen-rc-test-"));
  const path = join(directory, "center.sqlite");
  const github = new FakeGitHub();
  const plan = options.plan || makePlan();
  const planner = new FakePlanner(github, plan);
  const store = new Store(path, [github.token]);
  store.savePlan(plan);
  const engine = new Engine(store, planner, options.now, options.timeoutMs);
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  const submit = (mode: "dry-run" | "debug" = "debug", key = randomUUID()) =>
    engine.submit({ planId: plan.id, key, mode, confirmDebug: true });
  return { directory, path, store, github, planner, plan, engine, submit };
}
