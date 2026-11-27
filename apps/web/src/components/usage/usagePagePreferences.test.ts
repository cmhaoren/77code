import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readUsagePagePreferences, saveUsagePagePreferences } from "./usagePagePreferences";

const key = "t3code:usage-page-preferences:v1";
let values: Map<string, string>;
let storage: Pick<Storage, "getItem" | "setItem">;

beforeEach(() => {
  values = new Map();
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("window", { localStorage: storage });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Usage page preferences", () => {
  it("defaults to tokens and today when storage is empty", () => {
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", period: "today" });
  });

  it("round-trips hidden providers and reads saves without them", () => {
    saveUsagePagePreferences({
      metric: "limits",
      period: "week",
      hiddenProviders: ["codex", "droid"],
    });
    expect(readUsagePagePreferences().hiddenProviders).toEqual(["codex", "droid"]);

    values.set(key, '{"metric":"tokens","period":"month"}');
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", period: "month" });
  });

  // regression: #10189 an invalid or legacy saved usage selection falls back and is replaced on next save
  it.each([
    "not-json",
    '{"metric":"unknown","period":"week"}',
    '{"metric":"cost","windowDays":7,"hiddenProviders":["codex"]}',
    '{"metric":"tokens","windowDays":30}',
    '{"metric":"limits","windowDays":30}',
  ])("falls back to defaults and replaces invalid or legacy preferences: %s", (value) => {
    values.set(key, value);
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", period: "today" });
    saveUsagePagePreferences({ metric: "tokens", period: "week" });
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", period: "week" });
  });
});
