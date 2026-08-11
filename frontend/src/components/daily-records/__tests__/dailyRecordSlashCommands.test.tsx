import { describe, expect, it } from "vitest";
import type { Editor } from "@tiptap/react";

import { getDailyRecordSlashCommands } from "@/components/daily-records/dailyRecordSlashCommands";

describe("daily record slash commands", () => {
  it("registers the complete high-frequency date command set", () => {
    const commands = getDailyRecordSlashCommands();
    expect(commands.map((command) => command.id)).toEqual([
      "daily-now",
      "daily-yesterday",
      "daily-today",
      "daily-tomorrow",
      "daily-day-after-tomorrow",
      "daily-this-monday",
      "daily-next-monday",
      "daily-pick-date",
    ]);
    expect(new Set(commands.map((command) => command.category))).toEqual(new Set(["日期与日记"]));
  });

  it("inserts a local timestamp immediately for the now command", () => {
    const inserted: unknown[] = [];
    const chain = {
      focus() { return this; },
      insertContent(value: unknown) { inserted.push(value); return this; },
      run() { return true; },
    };
    const editor = { chain: () => chain } as unknown as Editor;
    const command = getDailyRecordSlashCommands().find((item) => item.id === "daily-now");
    expect(command).toBeDefined();

    command!.action(editor);

    expect(inserted).toHaveLength(1);
    expect(String(inserted[0])).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} $/);
  });
});
