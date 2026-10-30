import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AssetDescription from "../AssetDescription";

const state=vi.hoisted(()=>({description:vi.fn(),native:false}));
vi.mock("@/lib/api",()=>({api:{files:{organization:state}}}));
vi.mock("@capacitor/core",()=>({Capacitor:{isNativePlatform:()=>state.native}}));
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key})}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.clearAllMocks();state.native=false;host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it("displays the confirmed description without calling any model",async()=>{
  state.description.mockResolvedValue({description:"User reviewed metadata"});
  await act(async()=>root.render(<AssetDescription id="file"/>));
  expect(state.description).toHaveBeenCalledWith("file");expect(host.textContent).toContain("User reviewed metadata");
});
it("reports unavailable metadata and refuses remote reads in Native mode",async()=>{
  state.description.mockRejectedValue(new Error("Forbidden"));
  await act(async()=>root.render(<AssetDescription id="file"/>));expect(host.textContent).toContain("assetAI.descriptionUnavailable");
  state.native=true;state.description.mockClear();await act(async()=>root.render(<AssetDescription key="native" id="native"/>));
  expect(state.description).not.toHaveBeenCalled();expect(host.textContent).toBe("");
});
it("discards a late response after the file changes",async()=>{
  let done!:(value:{description:string})=>void;
  state.description.mockImplementationOnce(()=>new Promise(resolve=>{done=resolve;})).mockResolvedValue({description:"New file"});
  await act(async()=>root.render(<AssetDescription key="old" id="old"/>));
  await act(async()=>root.render(<AssetDescription key="new" id="new"/>));
  await act(async()=>done({description:"Old private metadata"}));
  expect(host.textContent).toContain("New file");expect(host.textContent).not.toContain("Old private metadata");
});
