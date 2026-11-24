import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { formatRunEnv, newRunId, runDir, runDirFromEnv, writeRunFile } from "../src/run";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

describe("newRunId", () => {
  it("is a compact UTC timestamp, safe as a directory name", () => {
    expect(newRunId(new Date("2026-11-20T08:05:09.123Z"))).toBe("20261120T080509Z");
  });
});

describe("runDir", () => {
  it("lives under ~/.config/qday/runs/<runId>", () => {
    expect(runDir("20261120T080509Z", "/home/u")).toBe("/home/u/.config/qday/runs/20261120T080509Z");
  });

  it("resolves outside the repo for the real home directory (nothing secret is written inside the repo)", () => {
    const dir = runDir("20261120T080509Z");
    expect(relative(REPO_ROOT, dir).startsWith("..")).toBe(true);
  });

  it("refuses a run id that could escape the runs directory", () => {
    expect(() => runDir("../x", "/home/u")).toThrow(/run id/);
    expect(() => runDir("", "/home/u")).toThrow(/run id/);
  });

  it("refuses a home directory inside the repo", () => {
    expect(() => runDir("20261120T080509Z", REPO_ROOT)).toThrow(/inside the repo/);
  });

  it("runDirFromEnv needs RUN_ID", () => {
    expect(() => runDirFromEnv({})).toThrow(/RUN_ID/);
    expect(runDirFromEnv({ RUN_ID: "20261120T080509Z" }, "/home/u")).toBe("/home/u/.config/qday/runs/20261120T080509Z");
  });
});

describe("formatRunEnv", () => {
  it("writes KEY=\"value\" lines a shell and node --env-file both read", () => {
    expect(formatRunEnv({ RUN_ID: "r1", OWNER_MNEMONIC: "abandon ability able" })).toBe('RUN_ID="r1"\nOWNER_MNEMONIC="abandon ability able"\n');
  });

  it("refuses values a shell would expand or that break the line", () => {
    for (const bad of ['a"b', "a$b", "a`b", "a\\b", "a\nb"]) {
      expect(() => formatRunEnv({ X: bad })).toThrow(/X/);
    }
  });

  it("refuses invalid keys", () => {
    expect(() => formatRunEnv({ "bad key": "v" })).toThrow(/key/);
  });
});

describe("writeRunFile", () => {
  let base: string | undefined;
  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
    base = undefined;
  });

  it("creates the run dir 0700 and the file 0600", () => {
    base = mkdtempSync(join(tmpdir(), "qday-run-"));
    const dir = join(base, "runs", "r1");
    const file = writeRunFile(dir, "run.env", 'A="1"\n');
    expect(file).toBe(join(dir, "run.env"));
    expect(readFileSync(file, "utf8")).toBe('A="1"\n');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("with exclusive set, refuses to overwrite an existing file and leaves it untouched", () => {
    base = mkdtempSync(join(tmpdir(), "qday-run-"));
    const dir = join(base, "runs", "r1");
    writeRunFile(dir, "run.env", 'A="old"\n', { exclusive: true });
    expect(() => writeRunFile(dir, "run.env", 'A="new"\n', { exclusive: true })).toThrow(/EEXIST/);
    expect(readFileSync(join(dir, "run.env"), "utf8")).toBe('A="old"\n');
    writeRunFile(dir, "run.env", 'A="done"\n'); // the completing write still overwrites
    expect(readFileSync(join(dir, "run.env"), "utf8")).toBe('A="done"\n');
  });
});

describe("assertOutsideRepo", () => {
  it("refuses a path inside the repo and accepts one outside", async () => {
    const { assertOutsideRepo } = await import("../src/run");
    expect(() => assertOutsideRepo(join(__dirname, "x.env"))).toThrow(/inside the repo/);
    expect(() => assertOutsideRepo("/tmp/x.env")).not.toThrow();
  });
});
