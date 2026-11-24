import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

test("Phase E real app: metadata semantic search appears after a successful AI connection",async({page,request})=>{
  const response=await request.post("/api/auth/login",{data:{username:"assets_qa",password:"assets-qa-only-password"}});
  expect(response.ok()).toBe(true);
  const account=await response.json();
  const headers={Authorization:`Bearer ${account.token}`};
  await page.addInitScript(({token,refreshToken,version})=>{
    localStorage.setItem("nowen-token",token);localStorage.setItem("nowen-refresh-token",refreshToken);
    localStorage.setItem("i18nextLng","zh-CN");localStorage.setItem("nowen-seen-version",version);
  },{...account,version:JSON.parse(fs.readFileSync(path.resolve("../package.json"),"utf8")).version});
  const before=await (await request.get("/api/files?pageSize=60",{headers})).json();
  const chosen=before.items.slice(0,2) as Array<{id:string;filename:string;folderId:string|null}>;
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  const probeRoute=(url:URL)=>url.pathname.endsWith("/api/ai/test");
  await page.route(probeRoute,route=>route.fulfill({status:502,json:{success:false,error:"Fixture connection unavailable"}}));
  const failedProbe=page.waitForResponse(response=>probeRoute(new URL(response.url())));
  await page.goto("/");
  expect((await failedProbe).status()).toBe(502);
  // Like the other file-center flows, wait for initial note/workspace restoration.
  await expect(page.getByRole("button",{name:"插入加密内容（局部加密）",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"文件管理",exact:true}).click();
  const semanticSearch=page.getByRole("button",{name:"语义搜索",exact:true});
  await expect(semanticSearch).toHaveCount(0);
  await expect(page.getByRole("button",{name:"AI 帮我整理",exact:true})).toHaveCount(0);
  await page.unroute(probeRoute);
  await page.evaluate(()=>window.dispatchEvent(new Event("nowen:ai-profiles-changed")));
  await expect(semanticSearch).toBeVisible();
  await page.getByRole("button",{name:"选择文件",exact:true}).click();
  for(const file of chosen) await page.getByRole("button",{name:file.filename,exact:true}).click();
  await expect(page.getByRole("button",{name:"AI 帮我整理",exact:true})).toHaveCount(0);
  const evidence=path.resolve("../docs/qa/files-assets-center-v2/screenshots/phase-e");
  fs.mkdirSync(evidence,{recursive:true});
  await semanticSearch.click();
  const search=page.getByRole("dialog",{name:"语义搜索",exact:true});
  await search.getByRole("checkbox").check();
  await search.getByLabel("描述你要找的文件",{exact:true}).fill("design references");
  await search.getByRole("button",{name:"语义搜索",exact:true}).click();
  await expect(search).toContainText("已扫描 100 个文件");
  await search.getByRole("button",{name:"继续扫描下一批",exact:true}).click();
  await expect(search).toContainText("已扫描 103 个文件");
  await expect(search.getByRole("button",{name:"继续扫描下一批",exact:true})).toHaveCount(0);
  await search.locator(".overflow-y-auto").evaluate(element=>{element.scrollTop=0;});
  await page.screenshot({path:path.join(evidence,"semantic-search.png")});
  expect(errors).toEqual([]);
});
