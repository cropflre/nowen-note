import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { GitHub } from "./github.ts";
import { Planner } from "./planner.ts";
import { Store } from "./store.ts";
import { Engine } from "./engine.ts";
import { createApp } from "./app.ts";
import { Channels } from "./channels.ts";
import { Cloud } from "./cloud.ts";
import { Publication } from "./publication.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const tool = fileURLToPath(new URL("../", import.meta.url));
const token = process.env.NOWEN_RELEASE_GITHUB_TOKEN || "";
const storeToken = process.env.NOWEN_RELEASE_STORE_ACCESS_TOKEN || "";
const publishToken = process.env.NOWEN_RELEASE_PUBLISH_TOKEN || "";
const maintainerId = Number(process.env.NOWEN_RELEASE_MAINTAINER_ID || 0);
if (!Number.isSafeInteger(maintainerId) || maintainerId < 0) throw new Error("无效的 NOWEN_RELEASE_MAINTAINER_ID");
const port = Number(process.env.NOWEN_RELEASE_PORT || 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("无效的 NOWEN_RELEASE_PORT");
const planner = new Planner(
  root,
  new GitHub(token),
  process.env.NOWEN_RELEASE_WORKFLOW_REF || "release/v1.5.2",
  process.env.NOWEN_RELEASE_DEBUG === "1",
);
const store = new Store(
  join(
    process.env.NOWEN_RELEASE_DATA || join(homedir(), ".nowen-release-center"),
    "center.sqlite",
  ),
  [token, storeToken, publishToken],
);
const engine = new Engine(store, planner, undefined, undefined, new Publication(store, planner.github, new GitHub(publishToken), {
  maintainerId, drafts: process.env.NOWEN_RELEASE_DRAFTS === "1", publish: process.env.NOWEN_RELEASE_PUBLISH === "1",
}));
let vite:
  Awaited<ReturnType<(typeof import("vite"))["createServer"]>> | undefined;
if (process.argv.includes("--dev")) {
  const { createServer } = await import("vite");
  vite = await createServer({
    root: tool,
    server: { middlewareMode: true },
    appType: "spa",
  });
}
engine.start();
const cloud = new Cloud(store, planner.github, root, process.env.NOWEN_RELEASE_CLOUD_PUBLISH === "1");
const server = createApp(engine, {
  cloud,
  dist: join(tool, "dist"),
  dev: vite?.middlewares,
  channels: new Channels(store, planner.github, { storeToken }),
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Nowen Release Center · Phase 3 · http://127.0.0.1:${port}`),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  await engine.stop();
  await vite?.close();
  store.close();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
