import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api.impl";
afterEach(()=>{vi.unstubAllGlobals();localStorage.clear();});
it("does not delete a series on an older server that lacks the capability",async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:"Not found"}),{status:404}));vi.stubGlobal("fetch",fetch);
  await expect(api.deleteTask("repeat","series")).rejects.toMatchObject({code:"TASK_RECURRENCE_UNSUPPORTED"});
  expect(fetch).toHaveBeenCalledOnce();expect(fetch.mock.calls[0][0]).toContain("/tasks/recurrence/capabilities");
});
it("checks server support before sending a whole-series deletion",async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(Response.json({taskRecurrenceLifecycle:"v1"})).mockResolvedValueOnce(Response.json({success:true,affected:2}));vi.stubGlobal("fetch",fetch);
  await api.deleteTask("repeat","series");
  expect(fetch.mock.calls[1][0]).toContain("/tasks/repeat?mode=series");expect(fetch.mock.calls[1][1].method).toBe("DELETE");
});
