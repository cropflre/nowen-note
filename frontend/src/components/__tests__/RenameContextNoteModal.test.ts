import { describe, expect, it } from "vitest";
import { buildRenameNoteMutation } from "@/components/RenameContextNoteModal";

describe("RenameContextNoteModal", () => {
  it("keeps the freshly loaded server version in the rename mutation", () => {
    expect(buildRenameNoteMutation({ version: 7 }, "Q1 目标与 OKR1")).toEqual({
      title: "Q1 目标与 OKR1",
      version: 7,
    });
  });
});
