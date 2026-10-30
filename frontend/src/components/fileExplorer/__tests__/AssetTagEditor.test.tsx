import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AssetTagEditor from "../AssetTagEditor";

const mocks = vi.hoisted(() => ({
  workspace: "personal",
  list: vi.fn(),
  get: vi.fn(),
  tagFiles: vi.fn(),
  createTag: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/api", () => ({
  api: { files: { organization: mocks } },
  getCurrentWorkspace: () => mocks.workspace,
  getServerUrl: () => "https://qa.local",
}));
vi.mock("@/lib/offlineScope", () => ({
  getOfflineQueueStorageKey: () => "qa-user",
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const tag = { id: "tag", name: "Design", color: "#123456" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace = "personal";
  mocks.list.mockResolvedValue({
    supported: true,
    canManageTags: true,
    tags: [tag],
    smartFolders: [],
  });
  mocks.get.mockResolvedValue({ tags: [tag], duplicates: [], canManage: true });
  mocks.tagFiles.mockResolvedValue({ success: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it("does not read remote metadata when Native organization is unavailable", async () => {
  mocks.list.mockResolvedValue({
    supported: false,
    canManageTags: false,
    tags: [],
    smartFolders: [],
  });
  await act(async () => root.render(<AssetTagEditor ids={["file"]} />));
  expect(mocks.get).not.toHaveBeenCalled();
  expect(host.textContent).toContain("assetOrganization.nativeUnavailable");
});
it("retains assigned tags after a rejected removal and reports the failure", async () => {
  mocks.tagFiles.mockRejectedValue(new Error("Permission changed"));
  await act(async () => root.render(<AssetTagEditor ids={["file"]} />));
  await act(async () =>
    (
      host.querySelector(
        'button[title="assetOrganization.removeTag"]',
      ) as HTMLButtonElement
    ).click(),
  );
  expect(mocks.tagFiles).toHaveBeenCalledWith(["file"], ["tag"], "remove");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Permission changed",
  );
  expect(host.textContent).toContain("Design");
});
it("batch add and remove use additive operations on the selected files", async () => {
  await act(async () => root.render(<AssetTagEditor ids={["one", "two"]} />));
  for (const operation of ["add", "remove"])
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find(
          (button) => button.textContent === `assetOrganization.${operation}`,
        )!
        .click();
    });
  expect(mocks.tagFiles).toHaveBeenNthCalledWith(
    1,
    ["one", "two"],
    ["tag"],
    "add",
  );
  expect(mocks.tagFiles).toHaveBeenNthCalledWith(
    2,
    ["one", "two"],
    ["tag"],
    "remove",
  );
  expect(mocks.get).not.toHaveBeenCalled();
});
it("ignores stale metadata after a scope change", async () => {
  let resolve!: (value: unknown) => void;
  mocks.get.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => root.render(<AssetTagEditor ids={["file"]} />));
  mocks.workspace = "other-space";
  await act(async () =>
    resolve({ tags: [tag], duplicates: [], canManage: true }),
  );
  expect(host.textContent).not.toContain("Design");
  expect(mocks.tagFiles).not.toHaveBeenCalled();
});
