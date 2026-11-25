import type { TFunction } from "i18next";
import JSZip from "jszip";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBaseUrl: vi.fn(), getScope: vi.fn(), confirm: vi.fn(), install: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ getBaseUrl: mocks.getBaseUrl }));
vi.mock("@/lib/offlineScope", () => ({ getOfflineQueueStorageKey: mocks.getScope }));
vi.mock("@/components/ui/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("@/lib/pluginApi", () => ({ pluginApi: { install: mocks.install } }));
vi.mock("@/store/AppContext", () => ({ useAppActions: vi.fn() }));
import { installPackageFile } from "../extension-center/extensionActions";

it("DCC-006: refuses to upload a package if the active account or server changes during confirmation", async () => {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({ name: "Local sample", runtime: "sandbox-js", permissions: [] }));
  const file = new File([await zip.generateAsync({ type: "arraybuffer" })], "sample.nowen-plugin");
  const t = ((key: string) => key) as TFunction;
  for (const changed of [mocks.getBaseUrl, mocks.getScope]) {
    mocks.getBaseUrl.mockReturnValue("/api");
    mocks.getScope.mockReturnValue("admin-one");
    mocks.confirm.mockImplementationOnce(async () => {
      changed.mockReturnValue("new-target");
      return true;
    });
    await expect(installPackageFile(file, t)).rejects.toThrow("extensionCenter.upload.accountChanged");
  }
  expect(mocks.install).not.toHaveBeenCalled();
});
