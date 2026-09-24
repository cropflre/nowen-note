// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { getDefaultSlashCommands } from "@/components/SlashCommands";

describe("mind map foolproof insertion command", () => {
  it("exposes a searchable /思维导图 command and opens the picker without requiring an ID", () => {
    const commands = getDefaultSlashCommands((key) => key);
    const item = commands.find((command) => command.id === "mindmap");

    expect(item).toBeTruthy();
    expect(item?.label).toBe("思维导图");
    expect(item?.keywords).toEqual(expect.arrayContaining(["脑图", "思维导图", "mindmap"]));

    const handler = vi.fn();
    window.addEventListener("nowen:open-mindmap-insert", handler, { once: true });

    item?.action({} as any);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
