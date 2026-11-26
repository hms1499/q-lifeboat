import { describe, expect, it } from "vitest";
import { keysNeeded } from "./keys";

describe("keysNeeded", () => {
  it("asks only for what the action lacks", () => {
    expect(keysNeeded({ classical: false, pqc: false }, "pqc")).toEqual({ password: true, code: true });
    expect(keysNeeded({ classical: true, pqc: false }, "pqc")).toEqual({ password: false, code: true });
    expect(keysNeeded({ classical: true, pqc: true }, "pqc")).toEqual({ password: false, code: false });
    expect(keysNeeded({ classical: false, pqc: false }, "classical")).toEqual({ password: true, code: false });
    expect(keysNeeded({ classical: true, pqc: false }, "classical")).toEqual({ password: false, code: false });
  });
});
