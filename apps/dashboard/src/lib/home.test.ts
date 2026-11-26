import { describe, expect, it } from "vitest";
import { LINKS, PROOF, resolveScreen } from "./home";

describe("resolveScreen", () => {
  it("#/ is the homepage for a browser with no wallet, Overview with one, nothing while checking", () => {
    expect(resolveScreen("", false)).toBe("home");
    expect(resolveScreen("", true)).toBe("overview");
    expect(resolveScreen("", undefined)).toBeNull();
  });

  it("named screens open as asked; an unknown one falls back to Overview", () => {
    expect(resolveScreen("home", true)).toBe("home");
    expect(resolveScreen("start", false)).toBe("start");
    expect(resolveScreen("incidents", true)).toBe("incidents");
    expect(resolveScreen("nope", false)).toBe("overview");
  });
});

describe("homepage proof data (docs/EVIDENCE.md, Task 12)", () => {
  it("lists the three browser-run rescues, each two blocks after the leak", () => {
    expect(PROOF.map((p) => p.owner)).toEqual(["0xd23f…313a", "0x7f4f…8d99", "0x337a…56b6"]);
    for (const p of PROOF) {
      expect(p.rescueBlock - p.leakBlock).toBe(2);
      expect(p.rescueTx).toMatch(/^0x[0-9a-f]{8}…[0-9a-f]{4}$/);
      expect(p.kept).toBe("90 %");
    }
  });

  it("links point at the public repo's main branch", () => {
    for (const url of Object.values(LINKS)) expect(url).toMatch(/^https:\/\/github\.com\/hms1499\/q-lifeboat(\/blob\/main\/.+)?$/);
  });
});
