import { describe, it, expect } from "vitest";
import { isReasoningModel, samplingFor } from "../src/aiShared.js";

describe("isReasoningModel", () => {
  it("treats gpt-5 family and o-series as reasoning models", () => {
    for (const m of ["gpt-5.4-mini", "gpt-5.5", "gpt-5", "o1", "o3-mini", "GPT-5.4-MINI"]) {
      expect(isReasoningModel(m)).toBe(true);
    }
  });

  it("treats classic chat models as non-reasoning", () => {
    for (const m of ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-3.5-turbo"]) {
      expect(isReasoningModel(m)).toBe(false);
    }
  });
});

describe("samplingFor", () => {
  it("passes temperature through for classic models", () => {
    expect(samplingFor({ temperature: 0.4, model: "gpt-4o-mini" })).toEqual({ temperature: 0.4 });
  });

  it("drops temperature for reasoning models (it is unsupported and 400s)", () => {
    expect(samplingFor({ temperature: 0.2, model: "gpt-5.4-mini" })).toEqual({});
  });
});
