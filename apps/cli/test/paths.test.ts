import { describe, expect, it } from "vitest";
import { resolveUserPath } from "../src/paths";

describe("resolveUserPath", () => {
  it("resolves relative paths against INIT_CWD (where the user ran pnpm)", () => {
    expect(resolveUserPath("withdrawal.json", { INIT_CWD: "/repo" })).toBe("/repo/withdrawal.json");
  });
  it("falls back to process.cwd()", () => {
    expect(resolveUserPath("x.json", {})).toBe(`${process.cwd()}/x.json`);
  });
  it("keeps absolute paths", () => {
    expect(resolveUserPath("/tmp/x.json", { INIT_CWD: "/repo" })).toBe("/tmp/x.json");
  });
});
