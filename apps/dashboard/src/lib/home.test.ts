import { describe, expect, it } from "vitest";
import { LINKS, PROOF } from "./home";

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
