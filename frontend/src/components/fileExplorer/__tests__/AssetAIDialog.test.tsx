import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AssetAIDialog from "../AssetAIDialog";
import type { AssetAIPreview } from "@/lib/assetAI";

const state = vi.hoisted(() => ({aiPreview:vi.fn(),aiConfirm:vi.fn(),aiSearch:vi.fn(),workspace:"personal"}));
vi.mock("@/lib/api",()=>({api:{files:{organization:state}},getCurrentWorkspace:()=>state.workspace}));
vi.mock("react-i18next",async importOriginal=>({...await importOriginal<typeof import("react-i18next")>(),useTranslation:()=>({t:(key:string,options?:{count?:number})=>key+(options?.count===undefined?"":":"+options.count),i18n:{language:"en"}})}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,host:HTMLDivElement,active:boolean;
const files=[{id:"a",filename:"Research.pdf"},{id:"b",filename:"Image.png"}];
const plan=():AssetAIPreview=>({items:files.map(file=>({...file,expected:"e".repeat(64),folderId:null,newFolderName:"Learning",tags:["Reference"],description:"Inferred from metadata",reason:"Metadata only"})),folders:[{id:"folder",name:"Existing",parentId:null}],metadataOnly:true});
const applied=vi.fn(),close=vi.fn(),open=vi.fn();
async function render(mode:"organize"|"search"="organize") {await act(async()=>root.render(<AssetAIDialog mode={mode} files={files} isCurrent={()=>active} onClose={close} onApplied={applied} onOpen={open}/>));}
function button(key:string) {return [...host.querySelectorAll("button")].find(element=>element.textContent?.startsWith(key))!;}
async function click(key:string) {await act(async()=>button(key).click());}
async function consent() {await act(async()=>host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());}
async function fill(element:HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement,value:string) {
  await act(async()=>{
    const prototype=element instanceof HTMLSelectElement?HTMLSelectElement.prototype:element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,"value")!.set!.call(element,value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement?"change":"input",{bubbles:true}));
  });
}
beforeEach(()=>{
  vi.clearAllMocks();active=true;state.workspace="personal";
  state.aiPreview.mockResolvedValue(plan());state.aiConfirm.mockResolvedValue({updated:1});state.aiSearch.mockResolvedValue({matches:[],examined:100,nextAfter:"after-100",metadataOnly:true});
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});

it("generates and confirms on HTTP origins without crypto.randomUUID",async()=>{
  vi.stubGlobal("crypto",{getRandomValues:globalThis.crypto.getRandomValues.bind(globalThis.crypto)});
  await render();await consent();await click("assetAI.generate");await click("assetAI.confirm");
  expect(state.aiConfirm).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),expect.any(Array));
  expect(applied).toHaveBeenCalledOnce();
});

it("requires metadata consent and keeps generation separate from confirmed writes",async()=>{
  await render();expect(button("assetAI.generate").disabled).toBe(true);expect(state.aiPreview).not.toHaveBeenCalled();
  await consent();await click("assetAI.generate");
  expect(state.aiPreview).toHaveBeenCalledWith(["a","b"],"en",expect.any(AbortSignal));
  expect(state.aiConfirm).not.toHaveBeenCalled();expect(host.textContent).toContain("Research.pdf");expect(host.textContent).toContain("assetAI.confirm:2");
});
it("allows target, tags and description edits and excludes deselected suggestions",async()=>{
  await render();await consent();await click("assetAI.generate");
  await fill(host.querySelector("select")!,"folder");
  await fill(host.querySelector<HTMLInputElement>('input[aria-label="assetAI.tags"]')!,"Edited, Project");
  await fill(host.querySelector("textarea")!,"User reviewed description");
  await act(async()=>host.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')[1].click());
  await click("assetAI.confirm");
  expect(state.aiConfirm).toHaveBeenCalledWith(expect.any(String),[expect.objectContaining({id:"a",folderId:"folder",newFolderName:null,tags:["Edited","Project"],description:"User reviewed description"})]);
  expect(applied).toHaveBeenCalledOnce();expect(host.textContent).toContain("assetAI.applied:1");
});
it("retries an unconfirmed response with the same frozen request and edited payload",async()=>{
  state.aiConfirm.mockRejectedValueOnce(new Error("lost response"));
  await render();await consent();await click("assetAI.generate");await click("assetAI.confirm");
  expect(host.querySelector("fieldset")?.disabled).toBe(true);expect(host.textContent).toContain("assetAI.retryHint");
  await click("assetAI.confirm");
  expect(state.aiConfirm.mock.calls[1]).toEqual(state.aiConfirm.mock.calls[0]);
});
it("blocks invalid tags or an empty new folder before any write attempt",async()=>{
  await render();await consent();await click("assetAI.generate");
  await fill(host.querySelector<HTMLInputElement>('input[aria-label="assetAI.newFolder"]')!,"");
  await click("assetAI.confirm");expect(state.aiConfirm).not.toHaveBeenCalled();expect(host.textContent).toContain("assetAI.invalid");
  expect(host.querySelector("fieldset")?.disabled).toBe(false);
});
it("does not confirm or display late suggestions after identity changes",async()=>{
  let done!:(value:ReturnType<typeof plan>)=>void;
  state.aiPreview.mockImplementation(()=>new Promise(resolve=>{done=resolve;}));
  await render();await consent();
  await act(async()=>{button("assetAI.generate").click();});
  active=false;await act(async()=>done(plan()));
  expect(host.textContent).not.toContain("Research.pdf");expect(state.aiConfirm).not.toHaveBeenCalled();
});
it("aborts generation when its dialog is unmounted",async()=>{
  state.aiPreview.mockImplementation(()=>new Promise(()=>{}));
  await render();await consent();await act(async()=>button("assetAI.generate").click());
  const signal=state.aiPreview.mock.calls[0][2] as AbortSignal;
  await act(async()=>root.render(null));expect(signal.aborted).toBe(true);
});
it("semantic continuation keeps the searched query and never applies file mutations",async()=>{
  await render("search");await consent();await fill(host.querySelector<HTMLInputElement>('input[aria-label="assetAI.query"]')!,"research material");await click("assetAI.search");
  await fill(host.querySelector<HTMLInputElement>('input[aria-label="assetAI.query"]')!,"different unsent text");await click("assetAI.more");
  expect(state.aiSearch.mock.calls[1]).toEqual(["research material","after-100",expect.any(AbortSignal)]);
  expect(state.aiConfirm).not.toHaveBeenCalled();expect(state.aiPreview).not.toHaveBeenCalled();
});
it("keeps ordinary navigation available after AI configuration errors",async()=>{
  state.aiPreview.mockRejectedValue(Object.assign(new Error("not configured"),{code:"AI_NOT_CONFIGURED"}));
  await render();await consent();await click("assetAI.generate");
  expect(host.textContent).toContain("assetAI.AI_NOT_CONFIGURED");expect(button("common.close").disabled).toBe(false);
  await click("common.close");expect(close).toHaveBeenCalled();
});
it("keeps folder selectors out of workspace suggestions",async()=>{
  state.workspace="team";const value=plan();value.items.forEach(item=>{item.newFolderName=null;});state.aiPreview.mockResolvedValue(value);
  await render();await consent();await click("assetAI.generate");expect(host.querySelector("select")).toBeNull();
});
it("freezes the candidate IDs and count while the surrounding file list refreshes",async()=>{
  await render();
  await act(async()=>root.render(<AssetAIDialog mode="organize" files={[{id:"replacement",filename:"Different.txt"}]} isCurrent={()=>active} onClose={close} onApplied={applied} onOpen={open}/>));
  await consent();await click("assetAI.generate");
  expect(state.aiPreview.mock.calls[0][0]).toEqual(["a","b"]);expect(host.textContent).toContain("assetAI.fileCount:2");
});
