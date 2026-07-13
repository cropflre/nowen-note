import React from "react";
import { HabitRow as HabitRowImpl } from "./HabitRowImpl";
import type { Habit, HabitCheckinStatus } from "@/types";

export function HabitRow(props: {
  habit: Habit;
  onCheckin: (habit: Habit, status: HabitCheckinStatus, note: string) => Promise<void> | void;
  onArchiveToggle: (habit: Habit, archived: boolean) => Promise<void> | void;
  onDelete: (habit: Habit) => Promise<void> | void;
}) {
  return (
    <div data-nowen-habit-row="true">
      <HabitRowImpl {...props} />
    </div>
  );
}
