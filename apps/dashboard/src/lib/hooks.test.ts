import { describe, expect, it } from "vitest";
import { isSlow } from "./hooks";

describe("isSlow", () => {
  it("is false without a start", () => expect(isSlow(null, 100_000, false)).toBe(false));
  it("is false under 8 s", () => expect(isSlow(1_000, 8_999, false)).toBe(false));
  it("is true over 8 s without data", () => expect(isSlow(1_000, 9_001, false)).toBe(true));
  it("is false once there is data", () => expect(isSlow(1_000, 99_000, true)).toBe(false));
});
