// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { attachments: { upload: mocks.upload } }, getServerUrl: () => "" }));
vi.mock("@/lib/toast", () => ({ toast: {} }));
import { uploadPhotoSelection } from "../imageUploadService";
describe("照片和 MOV 同时选择时保存两份原件，正文只返回照片", () => {
  beforeEach(() => { mocks.upload.mockReset(); mocks.upload.mockImplementation(async (_note, file: File) => ({ category: file.name.endsWith("MOV") ? "file" : "image", url: `/api/attachments/${file.name}`, filename: file.name })); });
  it("MOV 先上传，HEIC 空 MIME 按文件名进入照片入口", async () => {
    const image = new File(["heic"], "IMG.HEIC"); const movie = new File(["mov"], "IMG.MOV");
    const result = await uploadPhotoSelection("note", [image, movie]);
    expect(mocks.upload.mock.calls.map((call) => call[1].name)).toEqual(["IMG.MOV", "IMG.HEIC"]);
    expect(result).toEqual([{ url: "/api/attachments/IMG.HEIC", filename: "IMG.HEIC" }]);
  });
  it("只有 MOV 或混入其它文档时不开始上传", async () => {
    await expect(uploadPhotoSelection("note", [new File(["mov"], "IMG.MOV")])).rejects.toThrow("请选择照片");
    await expect(uploadPhotoSelection("note", [new File(["png"], "IMG.png"), new File(["doc"], "work.doc")])).rejects.toThrow("请选择照片");
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
