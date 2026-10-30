import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import i18n from "@/i18n";
import SimilarImages from "../fileExplorer/SimilarImages";
import BatchRenameDialog from "../fileExplorer/BatchRenameDialog";
import type { SimilarImageResult, FileDetail } from "@/types";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const button = (text: string) =>
  [...host.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  )!;
const empty: SimilarImageResult = {
  matches: [],
  examined: 0,
  skipped: 0,
  nextAfter: null,
  accessUrls: {},
};
it("aborts closed image searches and ignores late results", async () => {
  let resolve!: (value: SimilarImageResult) => void;
  let signal: AbortSignal | undefined;
  vi.spyOn(api.files.tools, "similar").mockImplementation(
    (_id, _after, currentSignal) => {
      signal = currentSignal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  );
  await act(async () =>
    root.render(
      <SimilarImages
        source={{ id: "source", filename: "Source.png" }}
        isCurrent={() => true}
        onClose={() => undefined}
        onOpen={() => undefined}
      />,
    ),
  );
  await act(async () => root.render(null));
  expect(signal?.aborted).toBe(true);
  await act(async () =>
    resolve({
      ...empty,
      matches: [{ id: "late", filename: "Late.png", size: 1, distance: 0 }],
    }),
  );
  expect(host.textContent).not.toContain("Late.png");
});
it("keeps scanned coverage on errors, retries the same page and ignores results from an old identity", async () => {
  let current = true;
  const similar = vi
    .spyOn(api.files.tools, "similar")
    .mockResolvedValueOnce({
      ...empty,
      examined: 20,
      nextAfter: "cursor-one",
      matches: [{ id: "x", filename: "Match.png", size: 10, distance: 1 }],
    })
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce({ ...empty, examined: 4, skipped: 1 });
  await act(async () =>
    root.render(
      <SimilarImages
        source={{ id: "source", filename: "Source.png" }}
        isCurrent={() => current}
        onClose={() => undefined}
        onOpen={() => undefined}
      />,
    ),
  );
  expect(host.textContent).toContain("Checked 20");
  await act(async () => button("Check next batch").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Offline");
  await act(async () => button("Retry").click());
  expect(similar.mock.calls.slice(1).map((args) => args[1])).toEqual([
    "cursor-one",
    "cursor-one",
  ]);
  expect(host.textContent).toContain("Checked 24");
  expect(host.textContent).toContain("Current scan complete");
  // Starting a request after an identity change must not use the new account.
  current = false;
  await act(async () => button("Match.png10 B").click());
  expect(similar).toHaveBeenCalledTimes(3);
});
it("previews original extensions and refreshes conflicts before confirming a batch rename", async () => {
  const onClose = vi.fn(),
    onRenamed = vi.fn();
  let current = true;
  const rename = vi
    .spyOn(api.files.tools, "batchRename")
    .mockRejectedValueOnce(
      Object.assign(new Error("stale"), { code: "FILE_NAME_CONFLICT" }),
    )
    .mockResolvedValue({ success: true, renamed: 1 });
  vi.spyOn(api.files, "get").mockResolvedValue({
    id: "a",
    filename: "Updated.PNG",
  } as FileDetail);
  await act(async () =>
    root.render(
      <BatchRenameDialog
        files={[{ id: "a", filename: "Old.PNG" }]}
        isCurrent={() => current}
        onClose={onClose}
        onRenamed={onRenamed}
      />,
    ),
  );
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "Reference");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.textContent).toContain("Reference-001.PNG");
  current = false;
  await act(async () => button("Rename 1 files").click());
  expect(rename).not.toHaveBeenCalled();
  current = true;
  await act(async () => button("Rename 1 files").click());
  expect(host.textContent).toContain("This batch was not modified");
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => button("Refresh preview").click());
  await act(async () => button("Rename 1 files").click());
  expect(rename).toHaveBeenLastCalledWith([
    { id: "a", filename: "Reference-001.PNG", expectedFilename: "Updated.PNG" },
  ]);
  expect(onRenamed).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});
