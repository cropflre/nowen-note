import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ServerAddressInput from "../ServerAddressInput";
import { buildServerUrl, type ServerAddressParts } from "@/lib/serverUrl";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const blank: ServerAddressParts = { protocol: "http", host: "", port: "", path: "" };

describe("issue #808: server address field on desktop login", () => {
  let host: HTMLDivElement;
  let root: Root;
  let latest: ServerAddressParts;
  let onBlur: ReturnType<typeof vi.fn>;

  function Harness() {
    const [value, setValue] = useState<ServerAddressParts>(blank);
    return (
      <ServerAddressInput
        value={value}
        onChange={(next) => { latest = next; setValue(next); }}
        onHostBlur={onBlur}
        accent="indigo"
      />
    );
  }

  beforeEach(async () => {
    latest = { ...blank };
    onBlur = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  function address(): HTMLInputElement {
    return host.querySelector<HTMLInputElement>('input[aria-label="server.addressLabel"]')!;
  }
  async function input(raw: string) {
    await act(async () => {
      const field = address();
      field.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, raw);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("preserves literal https:// URL and the input caret during edits; normalizes only after blur", async () => {
    const url = "https://notes.example.com:8443/reverse/api/health";
    await input(url);
    expect(address().value).toBe(url);
    expect(latest.protocol).toBe("https");
    expect(buildServerUrl(latest)).toBe("https://notes.example.com:8443/reverse");
    await act(async () => address().blur());
    expect(address().value).toBe("https://notes.example.com:8443/reverse");
    expect(onBlur).toHaveBeenCalledWith(expect.objectContaining({
      protocol: "https", host: "notes.example.com", port: "8443", path: "/reverse",
    }));
  });

  it("does not rewrite middle-of-text edits or remove a typed protocol mid-input", async () => {
    await input("https://example.org:3001/notes");
    const field = address();
    field.setSelectionRange(16, 16);
    await input("https://example.org:3001/new-notes");
    expect(address().value).toBe("https://example.org:3001/new-notes");
    expect(latest.path).toBe("/new-notes");
  });

  it("clearing an old server does not keep a stale host for submission", async () => {
    await input("192.168.1.3:3001");
    expect(latest.host).toBe("192.168.1.3");
    await input("");
    expect(address().value).toBe("");
    expect(latest.host).toBe("");
    expect(buildServerUrl(latest)).toBe("");
  });

  it("is a single paste-friendly field without a protocol menu", async () => {
    expect(host.querySelector('[aria-haspopup="listbox"]')).toBeNull();
    expect(host.querySelector("select")).toBeNull();
    expect(host.querySelectorAll("input")).toHaveLength(1);
    expect(address().getAttribute("inputmode")).toBe("url");
  });

  it.each([
    ["notes.example.com", "https://notes.example.com"],
    ["notes.example.com:8443/nowen", "https://notes.example.com:8443/nowen"],
    ["http://notes.example.com", "http://notes.example.com"],
    ["https://192.168.1.10:3001", "https://192.168.1.10:3001"],
    ["192.168.1.10:3001", "http://192.168.1.10:3001"],
    ["nas:5000/note", "http://nas:5000/note"],
    ["nas.local:3001", "http://nas.local:3001"],
    ["localhost:3001", "http://localhost:3001"],
    ["[fd00::10]:3001", "http://[fd00::10]:3001"],
    ["https://lucky.example.com/public", "https://lucky.example.com/public"],
  ])("resolves %s to %s", async (raw, expected) => {
    await input(raw);
    await act(async () => address().blur());
    expect(buildServerUrl(latest)).toBe(expected);
    expect(address().value).toBe(expected);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("does not report an unparsable address on blur", async () => {
    await input("http://");
    await act(async () => address().blur());
    expect(onBlur).not.toHaveBeenCalled();
    expect(latest.host).toBe("");
  });

  it("accepts a restored server address while an untouched input has autofocus", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<ServerAddressInput value={blank} onChange={onChange} autoFocus />));
    expect(document.activeElement).toBe(address());
    await act(async () => root.render(<ServerAddressInput
      value={{ protocol: "https", host: "note.nowen.cn", port: "", path: "" }}
      onChange={onChange} autoFocus />));
    expect(address().value).toBe("https://note.nowen.cn");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not overwrite actual typing with a late restored address", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<ServerAddressInput value={blank} onChange={onChange} autoFocus />));
    await input("https://typed.example.com/custom");
    await act(async () => root.render(<ServerAddressInput
      value={{ protocol: "https", host: "restored.example.com", port: "", path: "" }}
      onChange={onChange} autoFocus />));
    expect(address().value).toBe("https://typed.example.com/custom");
  });
});
