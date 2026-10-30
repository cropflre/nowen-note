import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getUserWorkspaceRole, requireWorkspaceFeature } from "../middleware/acl.js";
import { AssetAIError, previewAssets, confirmAssets, searchAssetMetadata, readAssetDescription, previewSchema, confirmSchema, searchSchema } from "../services/asset-ai.js";

const app = new Hono();
const active = new Set<string>();
app.use("*", bodyLimit({maxSize: 256000, onError: c => c.json({code:"REQUEST_TOO_LARGE",error:"Request too large"},413)}));
app.use("*", async (c,next) => {
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({code:"UNAUTHORIZED",error:"Sign in first."},401);
  if (c.req.header("X-Api-Resource-Mode") === "restricted") return c.json({code:"FORBIDDEN",error:"Restricted tokens cannot use file AI."},403);
  const workspaceId = c.req.query("workspaceId");
  if (workspaceId && workspaceId !== "personal" && !getUserWorkspaceRole(workspaceId,userId)) return c.json({code:"FORBIDDEN",error:"Workspace access denied."},403);
  c.header("Cache-Control","private, no-store");
  await next();
});
app.use("*",requireWorkspaceFeature("files"));
app.onError((error,c) => {
  if (error instanceof AssetAIError) return c.json({code:error.code,error:error.message},error.status);
  return c.json({code:"ASSET_AI_REQUEST_FAILED",error:"AI request failed. Ordinary file search is still available."},502);
});
for (const action of ["preview","confirm","search"] as const) {
  app.post("/"+action,async c => {
    const userId = c.req.header("X-User-Id")!;
    const rawScope = c.req.query("workspaceId");
    const workspaceId = rawScope && rawScope !== "personal" ? rawScope : null;
    const raw = await c.req.json().catch(() => null);
    if (action === "confirm") {
      const parsed = confirmSchema.safeParse(raw);
      if (!parsed.success) throw new AssetAIError("ASSET_AI_INVALID_INPUT",400);
      return c.json(confirmAssets(userId,workspaceId,parsed.data));
    }
    if (active.has(userId) || active.size >= 4) throw new AssetAIError("ASSET_AI_BUSY",429);
    active.add(userId);
    try {
      if (action === "preview") {
        const parsed = previewSchema.safeParse(raw);
        if (!parsed.success) throw new AssetAIError("ASSET_AI_INVALID_INPUT",400);
        return c.json(await previewAssets(userId,workspaceId,parsed.data,c.req.raw.signal));
      }
      const parsed = searchSchema.safeParse(raw);
      if (!parsed.success) throw new AssetAIError("ASSET_AI_INVALID_INPUT",400);
      return c.json(await searchAssetMetadata(userId,workspaceId,parsed.data,c.req.raw.signal));
    } finally { active.delete(userId); }
  });
}
app.get("/metadata/:id", c => {
  const rawScope = c.req.query("workspaceId");
  return c.json(readAssetDescription(c.req.param("id"),c.req.header("X-User-Id")!,rawScope && rawScope !== "personal" ? rawScope : null));
});
export default app;
