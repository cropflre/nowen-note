import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShareBannerEditor from "../ShareBannerEditor";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("分享横幅编辑", () => {
  let host: HTMLDivElement;
  let root: Root;
  const change = vi.fn();
  const original = { enabled: true, image: "data:image/jpeg;base64,b2xk" };

  beforeEach(() => {
    change.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  function button(key: string) {
    return Array.from(host.querySelectorAll("button")).find(item => item.textContent === key)!;
  }
  async function upload(type = "image/png", size?: number) {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["image"], "banner.png", { type });
    if (size !== undefined) Object.defineProperty(file, "size", { value: size });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  }

  it("普通用户只读，未上传图片时无法开启", () => {
    act(() => root.render(<ShareBannerEditor value={original} onChange={change} disabled />));
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
    expect(button("settings.shareBannerChooseImage").disabled).toBe(true);
    act(() => root.render(<ShareBannerEditor value={{ enabled: false, image: "" }} onChange={change} disabled={false} />));
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
  });

  it("删除同时关闭横幅，切换开关保留图片", () => {
    act(() => root.render(<ShareBannerEditor value={original} onChange={change} disabled={false} />));
    act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    expect(change).toHaveBeenLastCalledWith({ ...original, enabled: false });
    act(() => button("settings.shareBannerRemove").click());
    expect(change).toHaveBeenLastCalledWith({ enabled: false, image: "" });
  });

  it("拒绝 SVG，原有横幅保持不变", async () => {
    act(() => root.render(<ShareBannerEditor value={original} onChange={change} disabled={false} />));
    await upload("image/svg+xml");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("settings.shareBannerInvalidImage");
    expect(change).not.toHaveBeenCalled();
  });

  it("超限的原始图片不进入读取和裁切流程", async () => {
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
    act(() => root.render(<ShareBannerEditor value={original} onChange={change} disabled={false} />));
    await upload("image/png", 10 * 1024 * 1024 + 1);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("settings.shareBannerTooLarge");
    expect(read).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
  });

  it("选择图片只预览，取消不修改；应用后才产生裁切图片", async () => {
    vi.stubGlobal("FileReader", class {
      result = "data:image/png;base64,bmV3";
      onload: (() => void) | null = null;
      readAsDataURL() { queueMicrotask(() => this.onload?.()); }
    });
    let holdImage = false;
    let finishImage!: () => void;
    vi.stubGlobal("Image", class {
      naturalWidth = 1600; naturalHeight = 800; onload: (() => void) | null = null;
      private source = "";
      set src(value: string) { this.source = value; if (holdImage) finishImage = () => this.onload?.(); else queueMicrotask(() => this.onload?.()); }
      get src() { return this.source; }
    });
    const draw = vi.fn();
    const context = { drawImage: draw, fillRect: vi.fn(), fillStyle: "" };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,Y3JvcA==");
    act(() => root.render(<ShareBannerEditor value={original} onChange={change} disabled={false} />));
    await upload();
    expect(change).not.toHaveBeenCalled();
    expect(host.querySelector("img")?.style.objectPosition).toBe("50% 50%");
    holdImage = true;
    await upload();
    expect(button("settings.shareBannerApplyCrop").disabled).toBe(true);
    expect(button("settings.shareBannerCancelCrop").disabled).toBe(true);
    await act(async () => finishImage());
    holdImage = false;
    act(() => button("settings.shareBannerCancelCrop").click());
    expect(change).not.toHaveBeenCalled();
    expect(host.querySelector("img")?.getAttribute("src")).toBe(original.image);
    await upload();
    act(() => button("settings.shareBannerApplyCrop").click());
    expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 200, 1600, 400, 0, 0, 1600, 400);
    expect(context.fillStyle).toBe("#ffffff");
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1600, 400);
    expect(change).toHaveBeenLastCalledWith({ enabled: true, image: "data:image/jpeg;base64,Y3JvcA==" });
  });
});
