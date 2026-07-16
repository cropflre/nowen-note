import { describe, expect, it } from "vitest";
import {
  buildCustomRepeatRule,
  parseRepeatRuleRequestValue,
  parseStoredCustomRepeatRule,
  serializeCustomRepeatRule,
  type CustomRepeatRuleDraft,
} from "../customRepeatRule";
import { normalizeTaskRepeatRequest } from "@/lib/taskUpdateSafetyBridge";

const draft: CustomRepeatRuleDraft = {
  calendar: "gregorian",
  frequency: "day",
  interval: 9,
  weekdays: [5, 1, 5],
  monthDay: 31,
  yearMonth: 8,
  yearDay: 15,
  lunarMonth: 7,
  lunarDay: 14,
};

describe("custom repeat rule request construction", () => {
  it("uses the current input value instead of the stale rendered interval", () => {
    expect(buildCustomRepeatRule(draft, { interval: 3 })).toEqual({
      calendar: "gregorian",
      frequency: "day",
      interval: 3,
    });
  });

  it("uses the newly selected frequency and removes fields from the previous frequency", () => {
    expect(buildCustomRepeatRule(
      { ...draft, frequency: "year" },
      { frequency: "month", monthDay: 12 },
    )).toEqual({
      calendar: "gregorian",
      frequency: "month",
      interval: 9,
      monthDay: 12,
    });
  });

  it("normalizes weekdays without duplicates and sorts them from 0 to 6", () => {
    expect(buildCustomRepeatRule(draft, {
      frequency: "week",
      weekdays: [5, 1, 5, 0, 7, -1],
    })).toEqual({
      calendar: "gregorian",
      frequency: "week",
      interval: 9,
      weekdays: [0, 1, 5],
    });
  });

  it("uses the newly selected lunar calendar and lunar date immediately", () => {
    expect(buildCustomRepeatRule(draft, {
      calendar: "lunar",
      interval: 2,
      lunarMonth: 8,
      lunarDay: 15,
    })).toEqual({
      calendar: "lunar",
      frequency: "year",
      interval: 2,
      lunarMonth: 8,
      lunarDay: 15,
    });
  });

  it("parses stored database JSON and accepts an optimistic object snapshot", () => {
    const expected = {
      calendar: "gregorian",
      frequency: "day",
      interval: 3,
    } as const;
    expect(parseStoredCustomRepeatRule(JSON.stringify(expected)).interval).toBe(3);
    expect(parseStoredCustomRepeatRule(expected).interval).toBe(3);
  });

  it("normalizes the optimistic string into an object at the HTTP request boundary", () => {
    const rule = buildCustomRepeatRule(draft, { interval: 3 });
    const serialized = serializeCustomRepeatRule(rule);
    expect(parseRepeatRuleRequestValue(serialized)).toEqual(rule);
    expect(normalizeTaskRepeatRequest({
      repeatRule: "custom",
      repeatRuleJson: serialized,
    }).repeatRuleJson).toEqual(rule);
    expect(parseRepeatRuleRequestValue(null)).toBeNull();
    expect(parseRepeatRuleRequestValue("not-json")).toBe("not-json");
  });

  it("keeps cancellation explicit and does not mutate patches without a custom rule", () => {
    expect(normalizeTaskRepeatRequest({ repeatRule: "none", repeatRuleJson: null })).toEqual({
      repeatRule: "none",
      repeatRuleJson: null,
    });
    const patch = { title: "保持普通更新" };
    expect(normalizeTaskRepeatRequest(patch)).toBe(patch);
  });
});
