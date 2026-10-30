import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Plan, Task } from "../shared.ts";
import type { Store } from "../server/store.ts";
import { FakeGitHub } from "./helpers.ts";
import { buildArchive } from "./archive-fixture.ts";

export async function seedDebugArtifacts(
  store: Store,
  github: FakeGitHub,
  plan: Plan,
) {
  const source: Task = {
    id: randomUUID(),
    key: randomUUID(),
    mode: "debug",
    plan,
    state: "succeeded",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deadline: Date.now() + 60_000,
    runId: 101,
    jobs: [],
    artifacts: [],
  };
  const metadata = new Map<number, any>();
  const archives = new Map<number, Buffer>();
  let downloads = 0;
  for (const [index, platform] of plan.platforms.entries()) {
    if (platform === "macos")
      throw Error(
        "Fixture supports Windows/Linux bytes, not actual macOS packages",
      );
    const { archive, digest } = await buildArchive({
      taskId: source.id,
      sha: plan.sha,
      version: plan.version,
      platform,
    });
    const artifact = {
      id: 9001 + index,
      name: `rc-debug-${source.id}-${platform}`,
      size: archive.length,
      digest,
      expired: false,
      verification: "not_downloaded" as const,
    };
    source.artifacts.push(artifact);
    archives.set(artifact.id, archive);
    metadata.set(artifact.id, {
      id: artifact.id,
      name: artifact.name,
      expired: false,
      digest,
      size_in_bytes: archive.length,
      workflow_run: { id: source.runId, head_sha: plan.workflowSha },
    });
  }
  github.remote = {
    id: source.runId,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    display_title: `Release Center debug ${source.id}`,
    head_sha: plan.workflowSha,
  };
  github.artifactMeta = async (id) => metadata.get(id);
  github.downloadArtifact = async (id, path, signal) => {
    signal.throwIfAborted();
    downloads++;
    await writeFile(path, archives.get(id)!);
  };
  store.create(source, `fixture:${source.id}`);
  store.save(
    source,
    "fixture.debug_seeded",
    "Test fixture only; never built or dispatched on GitHub",
  );
  return { source, metadata, archives, downloads: () => downloads };
}
