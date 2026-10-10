// @vitest-environment node
import { expect, it } from "vitest";
import { resolvePhotoUploadMime } from "../photoUploadMime";
function heif(major: string, compatible: string) {
  const bytes = new Uint8Array(20); const view = new DataView(bytes.buffer); view.setUint32(0, 20);
  bytes.set(new TextEncoder().encode("ftyp"), 4); bytes.set(new TextEncoder().encode(major), 8); bytes.set(new TextEncoder().encode(compatible), 16);
  return new File([bytes], "phone.HEIC");
}
it("原生空 MIME HEIC 识别兼容品牌，AVIF 和伪装扩展名不被误改", async () => {
  expect(await resolvePhotoUploadMime(heif("mif1", "heic"))).toBe("image/heic");
  expect(await resolvePhotoUploadMime(heif("mif1", "mif1"))).toBe("image/heif");
  expect(await resolvePhotoUploadMime(heif("avif", "mif1"))).toBe("application/octet-stream");
  expect(await resolvePhotoUploadMime(new File(["not a photo"], "fake.heic"))).toBe("application/octet-stream");
});
