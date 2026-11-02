import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ scope: "a", available: vi.fn(), activateSelection: vi.fn(), activate: vi.fn(), changed: vi.fn() }));
vi.mock("@/lib/aiProfiles", () => ({ aiProfiles: mocks, emitAIProfilesChanged: mocks.changed, getAIProfilesScope: () => mocks.scope }));
import AIProfileSwitcherBridge from "../AIProfileSwitcherBridge";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const available = {personalProfiles:[{id:"mine",name:"My AI",model:"my-chat"}],sharedProfiles:[{id:"team",name:"Team AI",model:"team-chat"}],active:{scope:"personal",id:"mine"},sharedSupported:true,unavailable:false};

describe("shared model switcher", () => {
  let host: HTMLDivElement; let header: HTMLDivElement; let root: Root;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  beforeEach(() => {
    vi.clearAllMocks(); mocks.scope = "a"; localStorage.setItem("i18nextLng", "zh-CN"); mocks.available.mockResolvedValue(available);
    header = document.createElement("div"); header.setAttribute("data-ai-chat-header", "1"); header.appendChild(document.createElement("div")); document.body.appendChild(header);
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => {act(()=>root.unmount()); host.remove(); header.remove(); localStorage.clear();});
  async function mount() { await act(async()=>{root.render(<AIProfileSwitcherBridge />); await settle();}); await act(settle); }

  it("groups personal and administrator provided profiles and selects by source", async()=>{
    await mount();
    expect([...header.querySelectorAll("optgroup")].map(g=>g.label)).toEqual(["个人配置","共享配置 · 管理员提供"]);
    mocks.available.mockResolvedValue({...available,active:{scope:"shared",id:"team"}});
    const select=header.querySelector("select")!;
    await act(async()=>{select.value="shared:team"; select.dispatchEvent(new Event("change",{bubbles:true}));});
    expect(mocks.activateSelection).toHaveBeenCalledWith({scope:"shared",id:"team"});
    expect(mocks.activate).not.toHaveBeenCalled(); expect(select.value).toBe("shared:team");
  });

  it("keeps a revoked shared selection visible until another model is chosen", async()=>{
    mocks.available.mockResolvedValue({...available,sharedProfiles:[],active:{scope:"shared",id:"revoked"},unavailable:true});
    await mount();
    const select=header.querySelector("select")!;
    expect(select.value).toBe("shared:revoked"); expect(select.selectedOptions[0].disabled).toBe(true);
    expect(select.title).toContain("当前共享配置不可用"); expect(select.disabled).toBe(false);
  });

  it("discards an old account directory after resetting identity (DCC-006)", async()=>{
    let finish!: (value: unknown) => void;
    mocks.available.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    await mount();
    mocks.scope="b"; mocks.available.mockResolvedValue({...available,sharedProfiles:[]});
    await act(async()=>{window.dispatchEvent(new Event("nowen:token-changed")); finish(available); await settle();});
    expect(header.textContent).not.toContain("Team AI");
  });
});
