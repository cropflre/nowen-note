import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Cloud } from "../server/cloud.ts";
import { GitHub } from "../server/github.ts";
import { fixture, root } from "./helpers.ts";
const sha = "a".repeat(40);
class CloudGitHub extends GitHub {
  count = 0;
  loseResponse = false;
  moving = false;
  found: any[] = [];
  constructor() { super("ghp_cloud_fixture_secret"); }
  override async resolve() { return this.moving ? "b".repeat(40) : sha; }
  override async content(path: string) { return readFile(join(root, path), "utf8"); }
  override async request(path: string, method = "GET") {
    if (method === "POST") { this.count++; if (this.loseResponse) throw Error("lost response ghp_cloud_fixture_secret"); }
    return {};
  }
  override async list() { return this.found; }
  override async run() { return {id:101,run_attempt:1,status:"completed",conclusion:"success",head_sha:sha,path:".github/workflows/release-build.yml"}; }
  override async jobs() { return []; }
  override async artifacts() { return ["release-windows","release-docker-amd64","release-docker-arm64","release-upk","release-manifest"].map((name, index) => ({id:index+1,name,size:1,digest:`sha256:${sha}${sha.slice(0,24)}`,expired:false,verification:"not_downloaded" as const})); }
}
const input = {branch:"release/v1.5.4",version:"1.5.4",targets:["windows","upk"]};
test("remote build pins source, adds Docker, preserves intent and never dispatches twice", async t => {
  const { store } = fixture(t); const github = new CloudGitHub();
  let cloud = new Cloud(store, github, root);
  const plan = await cloud.plan(input);
  assert.deepEqual(plan.targets,["windows","docker","upk"]);
  github.loseResponse = true;
  const value = await cloud.build({planId:plan.id,confirm:true});
  assert.equal(value.state,"unknown"); assert.equal(github.count,1);
  assert.doesNotMatch(JSON.stringify(value),/ghp_cloud_fixture_secret/);
  cloud = new Cloud(store,github,root);
  await cloud.build({planId:plan.id,confirm:true});
  await cloud.refresh(); assert.equal(github.count,1);
  github.found=[{id:101,display_title:`Release build ${plan.id}`,head_sha:sha,path:".github/workflows/release-build.yml"}];
  await cloud.refresh(); assert.equal(cloud.get(plan.id).state,"succeeded");
});
test("moving branches, missing confirmations and disabled publishing cannot mutate GitHub", async t => {
  const { store } = fixture(t); const github = new CloudGitHub(); const cloud = new Cloud(store,github,root);
  const plan = await cloud.plan(input);
  await assert.rejects(cloud.build({planId:plan.id}));
  github.moving=true;
  await assert.rejects(cloud.build({planId:plan.id,confirm:true}));
  await assert.rejects(cloud.publish({request_id:randomUUID()}));
  assert.equal(github.count,0);
});
test("a pending remote dispatch excludes both old and new build tasks", async t => {
  const { store, submit } = fixture(t); const github = new CloudGitHub(); const cloud = new Cloud(store,github,root);
  const plan = await cloud.plan(input);
  await cloud.build({planId:plan.id,confirm:true});
  assert.throws(() => submit());
  const next = await cloud.plan(input);
  await assert.rejects(cloud.build({planId:next.id,confirm:true}));
  assert.equal(github.count,1);
});

test("concurrent duplicate clicks dispatch once and missing artifacts cannot report success", async t => {
  const {store}=fixture(t);const github=new CloudGitHub();const cloud=new Cloud(store,github,root);
  const plan=await cloud.plan(input);
  await Promise.all([cloud.build({planId:plan.id,confirm:true}),cloud.build({planId:plan.id,confirm:true})]);
  assert.equal(github.count,1);
  github.found=[{id:101,display_title:`Release build ${plan.id}`,head_sha:sha,path:".github/workflows/release-build.yml"}];
  github.artifacts=async()=>[];
  await cloud.refresh();assert.equal(cloud.get(plan.id).state,"failed");assert.match(cloud.get(plan.id).error!,/缺少必要产物/);
});

test("cloud HTTP mutations require same-origin session and explicit build confirmation", async t => {
  const {engine,store}=fixture(t);const github=new CloudGitHub();const cloud=new Cloud(store,github,root);
  const {createApp}=await import("../server/app.ts");
  const server=createApp(engine,{dist:root,cloud});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}`;
  const unauthorized=await fetch(`${base}/api/cloud/plans`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});assert.equal(unauthorized.status,401);
  const session=await fetch(`${base}/api/session`);const cookie=session.headers.get("set-cookie")!.split(";")[0];
  const headers={cookie,"Content-Type":"application/json","X-Release-Center":"1"};
  const cross=await fetch(`${base}/api/cloud/plans`,{method:"POST",headers:{...headers,origin:"https://evil.invalid"},body:JSON.stringify(input)});assert.equal(cross.status,403);
  const post=async(path:string,body:any)=>fetch(`${base}/api/cloud/${path}`,{method:"POST",headers,body:JSON.stringify(body)});
  assert.equal((await post("plans",{...input,targets:["shell"]})).status,400);
  const response=await post("plans",input);assert.equal(response.status,201);const plan=await response.json();
  assert.equal((await post("build",{planId:plan.id})).status,400);
  assert.equal((await post("build",{planId:plan.id,confirm:true})).status,202);
  assert.equal(github.count,1);
});

test("an explicit GitHub rejection releases exclusion without claiming an unknown accepted build", async t => {
 const {store}=fixture(t);const github=new CloudGitHub();const cloud=new Cloud(store,github,root);
 const {AppError}=await import("../server/errors.ts");
 github.request=async(_path:string,method?:string)=>{if(method==="POST")throw new AppError(401,"expired token");return {};};
 const plan=await cloud.plan(input);const value=await cloud.build({planId:plan.id,confirm:true});
 assert.equal(value.state,"failed");assert.match(value.error!,/已拒绝触发/);
 assert.equal(store.db.prepare("SELECT id FROM cloud_requests WHERE active=1").get(),undefined);
});
