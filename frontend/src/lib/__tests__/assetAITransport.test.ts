import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api.impl";

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it("Native local mode refuses every new AI transport before making a network request",()=>{
  const fetch=vi.fn();vi.stubGlobal("fetch",fetch);vi.stubGlobal("Capacitor",{isNativePlatform:()=>true});
  expect(()=>api.files.organization.aiPreview(["file"],"en")).toThrow("Native local mode");
  expect(()=>api.files.organization.aiSearch("query")).toThrow("Native local mode");
  expect(()=>api.files.organization.aiConfirm("request",[])).toThrow("Native local mode");
  expect(()=>api.files.organization.description("file")).toThrow("Native local mode");
  expect(fetch).not.toHaveBeenCalled();
});
it("allows slow read-only model requests beyond the ordinary mutation timeout",async()=>{
  vi.useFakeTimers();
  let signal!:AbortSignal;
  vi.stubGlobal("fetch",vi.fn((_url:unknown,init:RequestInit)=>new Promise((_resolve,reject)=>{
    signal=init.signal!;signal.addEventListener("abort",()=>reject(new DOMException("Timeout","AbortError")),{once:true});
  })));
  const pending=expect(api.files.organization.aiPreview(["file"],"en")).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(31000);expect(signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(31000);await pending;expect(signal.aborted).toBe(true);
});
