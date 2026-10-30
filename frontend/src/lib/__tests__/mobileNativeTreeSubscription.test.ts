import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileSyncEngine, assertMobileSyncItems } from "../mobileSyncEngine";
import { NATIVE_TREE_ENTITY_SET, NATIVE_TREE_PENDING_SUBSCRIPTION } from "../nativeKnowledgeTreeSync";

const scope = {scopeKey:"personal",workspaceId:null,workspaceName:null,role:"owner",canWrite:true,accessFingerprint:"test"};
function fixture(bound=false) {
  const db = { query:vi.fn().mockResolvedValue(bound ? [{value:NATIVE_TREE_ENTITY_SET}] : []),run:vi.fn(),transaction:vi.fn() };
  const engine = new MobileSyncEngine({db:db as never,attachments:{} as never,serverUrl:"http://localhost:3001",token:"test",userId:"user",profileId:"profile",deviceId:"device"});
  return {db,engine:engine as unknown as {
    negotiateTree(value:typeof scope):Promise<void>;
    subscriptionParams(value:typeof scope):URLSearchParams;
  }};
}
const response = (body:unknown,status=200) => ({ok:status===200,status,json:async()=>body});
afterEach(() => { vi.unstubAllGlobals(); });

describe("native personal tree subscription", () => {
  it("negotiates the complete existing set and a stable device identity once per session", async () => {
    const {engine} = fixture();
    const fetchMock = vi.fn().mockResolvedValue(response({entityTypes:NATIVE_TREE_ENTITY_SET.split(",")}));
    vi.stubGlobal("fetch",fetchMock);
    await engine.negotiateTree(scope); await engine.negotiateTree(scope);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const params = engine.subscriptionParams(scope);
    expect(params.get("entityTypes")).toBe(NATIVE_TREE_ENTITY_SET); expect(params.get("deviceId")).toBe("device");
    expect(engine.subscriptionParams({...scope,workspaceId:"w",scopeKey:"workspace:w"} as never).has("entityTypes")).toBe(false);
    expect(() => assertMobileSyncItems([{entityType:"knowledge_tree_node",entityId:"note:n1",operation:"upsert"}],"changes",true)).not.toThrow();
  });
  it.each([undefined,NATIVE_TREE_ENTITY_SET.split(",").slice(0,-1)])("keeps the legacy protocol on a fresh profile when an old server reports %s", async (entityTypes) => {
    const {db,engine} = fixture();
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response({entityTypes})));
    await engine.negotiateTree(scope);
    expect(engine.subscriptionParams(scope).has("entityTypes")).toBe(false);
    expect(db.run).not.toHaveBeenCalled();
  });
  it("accepts an explicit unsupported-set response only before a tree cursor has been bound", async () => {
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response({code:"INVALID_PAYLOAD"},400)));
    const fresh = fixture(); await fresh.engine.negotiateTree(scope);
    expect(fresh.engine.subscriptionParams(scope).has("entityTypes")).toBe(false);
    const bound = fixture(true);
    await expect(bound.engine.negotiateTree(scope)).rejects.toMatchObject({code:"UNSUPPORTED_TREE_SUBSCRIPTION"});
    expect(bound.db.run).not.toHaveBeenCalled();
  });
  it("refuses to silently downgrade a persisted tree subscription even when the server returns legacy types", async () => {
    const {db,engine} = fixture(true);
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response({entityTypes:NATIVE_TREE_ENTITY_SET.split(",").slice(0,-1)})));
    await expect(engine.negotiateTree(scope)).rejects.toMatchObject({code:"UNSUPPORTED_TREE_SUBSCRIPTION"});
    expect(db.run).not.toHaveBeenCalled();
  });
  it("preserves subscription intent after a lost initial ACK instead of silently downgrading", async () => {
    const {db,engine} = fixture();
    db.query.mockResolvedValue([{value:NATIVE_TREE_PENDING_SUBSCRIPTION}]);
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response({code:"INVALID_PAYLOAD"},400)));
    await expect(engine.negotiateTree(scope)).rejects.toMatchObject({code:"UNSUPPORTED_TREE_SUBSCRIPTION"});
    expect(db.run).not.toHaveBeenCalled();
  });
  it.each(["AUTH_EXPIRED","SCOPE_FORBIDDEN"])("preserves %s failures instead of falling back", async (code) => {
    const {engine} = fixture();
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response({code},code==="AUTH_EXPIRED"?401:403)));
    await expect(engine.negotiateTree(scope)).rejects.toMatchObject({code});
  });
  it.each([["knowledge_tree_node"],["future_entity"],Array(11).fill("note")])("rejects malformed or partial entity sets: %s", async (entityTypes) => {
    const {engine} = fixture();
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response({entityTypes})));
    await expect(engine.negotiateTree(scope)).rejects.toMatchObject({code:"SERVER_ERROR"});
  });
  it("retries network failures without marking a legacy subscription as negotiated", async () => {
    const {engine} = fixture();
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("network")).mockResolvedValueOnce(response({entityTypes:NATIVE_TREE_ENTITY_SET.split(",")}));
    vi.stubGlobal("fetch",fetchMock);
    await expect(engine.negotiateTree(scope)).rejects.toMatchObject({code:"NETWORK_UNAVAILABLE"}); await engine.negotiateTree(scope);
    expect(engine.subscriptionParams(scope).get("entityTypes")).toBe(NATIVE_TREE_ENTITY_SET);
  });
});

it("negotiates the complete asset set only with explicit server capability confirmation",async()=>{
  const {NATIVE_ASSET_ENTITY_SET}=await import('../nativeAssetOrganization');const {engine}=fixture();
  const fetchMock=vi.fn().mockResolvedValue(response({entityTypes:NATIVE_ASSET_ENTITY_SET.split(','),assetOrganization:'personal-v1'}));vi.stubGlobal('fetch',fetchMock);
  await engine.negotiateTree({...scope,assetOrganization:'personal-v1'} as never);
  expect(engine.subscriptionParams(scope).get('entityTypes')).toBe(NATIVE_ASSET_ENTITY_SET);
  expect(()=>assertMobileSyncItems([{entityType:'attachment_organization',entityId:'folder:f',operation:'upsert'}],'changes',true,true)).not.toThrow();
  expect(()=>assertMobileSyncItems([{entityType:'attachment_organization',entityId:'folder:f',operation:'upsert'}],'changes',true,false)).toThrow();
});
it("retains a persisted asset subscription when a server no longer advertises that capability",async()=>{
  const {NATIVE_ASSET_ENTITY_SET}=await import('../nativeAssetOrganization');const {db,engine}=fixture();db.query.mockResolvedValue([{value:'pending:'+NATIVE_ASSET_ENTITY_SET}]);
  const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
  await expect(engine.negotiateTree(scope)).rejects.toMatchObject({code:'SERVER_ERROR'});
  expect(db.run).not.toHaveBeenCalled();expect(fetchMock).not.toHaveBeenCalled();
});
