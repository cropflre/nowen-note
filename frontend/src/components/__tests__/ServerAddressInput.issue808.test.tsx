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
    expect(address().value).toBe("notes.example.com:8443/reverse");
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

  it("uses an accessible custom protocol menu, without the browser-native select or outer focus ring", async () => {
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
    expect(trigger).toBeTruthy();
    expect(host.querySelector("select")).toBeNull();
    expect(host.querySelector(".focus-within\\:ring-2")).toBeNull();
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const https = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((button) => button.textContent?.startsWith("https:"))!;
    await act(async () => https.click());
    expect(latest.protocol).toBe("https");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(address());
  });

  it("does not auto-test the server while moving focus inside the protocol chooser", async () => {
    await input("nas.local:3001");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!.focus();
    });
    expect(onBlur).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!.click());
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[aria-haspopup="listbox"]'));
  });
});
