import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  Reflect.deleteProperty(window, "Capacitor");
  Reflect.deleteProperty(window, "CapacitorWebFetch");
});

it("sends the Unicode filename as UTF-8 form metadata and uses WebView multipart transport", async () => {
  localStorage.setItem("nowen-server-url", "https://notes.example");
  localStorage.setItem("nowen-token", "upload-test-token");
  Object.assign(window, { Capacitor: { isNativePlatform: () => true } });
  const patchedFetch = vi.fn(); vi.stubGlobal("fetch", patchedFetch);
  const webFetch = vi.fn(async () => new Response(JSON.stringify({ id: "file-1" }), { status: 201 }));
  Object.assign(window, { CapacitorWebFetch: webFetch });
  const file = new File(["content"], "中文文件 空格😀.pdf", { type: "application/pdf" });
  await api.files.upload(file, { folderId: "folder-1" });
  expect(patchedFetch).not.toHaveBeenCalled();
  const [url, init] = webFetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://notes.example/api/files/upload");
  const form = init.body as FormData;
  expect(form.get("file")).toBe(file);
  expect(form.get("originalFilename")).toBe(file.name);
  expect(form.get("folderId")).toBe("folder-1");
  expect(init.headers).toEqual({ Authorization: "Bearer upload-test-token" });
});
