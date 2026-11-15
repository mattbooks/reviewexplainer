import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createReviewExtension,
  parseSandboxSettings,
  protectGitDirProfile,
  resolveSandbox,
  safehouseCommand,
  sandboxTools,
  type SandboxPlan,
  type SandboxScope,
} from "../src/index.ts";
import { fakeSafehouse, type FakeSafehouse } from "./fake-safehouse.ts";

let dir: string;
let scope: SandboxScope;
let fake: FakeSafehouse;
let plan: SandboxPlan;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "greview-sandbox-"));
  mkdirSync(join(dir, "work"));
  writeFileSync(join(dir, "work", "a.txt"), "inside\n");
  writeFileSync(join(dir, "outside.txt"), "secret\n");
  scope = { workdir: join(dir, "work"), scratch: join(dir, "scratch"), readOnlyDirs: [join(dir, "objects")] };
  fake = fakeSafehouse(dir);
  plan = resolveSandbox({ mode: "safehouse", command: fake.command });
  process.env.GREVIEW_TEST_SECRET = "sk-should-not-leak";
});
afterEach(() => {
  delete process.env.GREVIEW_TEST_SECRET;
  rmSync(dir, { recursive: true, force: true });
});

const text = (r: any) => r.content.map((c: any) => c.text).join("");
const tool = (tools: any[], name: string) => tools.find((t) => t.name === name)!;
const run = (t: any, params: unknown) => t.execute("id", params, undefined, undefined, { cwd: scope.workdir });

describe("sandbox settings", () => {
  it("parses settings and rejects bad ones", () => {
    expect(parseSandboxSettings(undefined)).toEqual({ mode: "auto" });
    expect(parseSandboxSettings("readonly")).toEqual({ mode: "readonly" });
    expect(parseSandboxSettings({ mode: "safehouse", envPass: ["DATABASE_URL"], enable: ["docker"] })).toEqual({
      mode: "safehouse",
      envPass: ["DATABASE_URL"],
      enable: ["docker"],
    });
    expect(() => parseSandboxSettings({ mode: "yolo" })).toThrow(/Unknown sandbox mode/);
    expect(() => parseSandboxSettings({ envPass: "X" })).toThrow(/list of strings/);
  });

  it("uses safehouse when it can, falls back to read-only in auto, and fails loudly when asked for", () => {
    const found = () => "/opt/homebrew/bin/safehouse";
    expect(resolveSandbox({ mode: "auto" }, { platform: "darwin", which: found })).toMatchObject({ kind: "safehouse", command: "/opt/homebrew/bin/safehouse" });
    expect(resolveSandbox({ mode: "auto" }, { platform: "darwin", which: () => undefined })).toMatchObject({
      kind: "readonly",
      note: expect.stringContaining("brew install"),
    });
    expect(resolveSandbox({ mode: "auto" }, { platform: "linux", which: found })).toMatchObject({ kind: "readonly", note: expect.stringContaining("macOS") });
    expect(() => resolveSandbox({ mode: "safehouse" }, { platform: "darwin", which: () => undefined })).toThrow(/sandbox is set to safehouse/);
    expect(resolveSandbox({ mode: "none" })).toMatchObject({ kind: "none" });
    // An explicit wrapper is trusted on any platform.
    expect(resolveSandbox({ mode: "safehouse", command: fake.command }, { platform: "linux" })).toMatchObject({ kind: "safehouse" });
  });

  it("is ignored in repository config", async () => {
    const { loadConfig } = await import("@reviewexplainer/core");
    const repo = join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".greview.json"), JSON.stringify({ sandbox: { mode: "none" }, model: "x/y" }));
    const config = loadConfig(repo);
    expect(config.sandbox).toBeUndefined();
    expect(config.model).toBe("x/y");
  });
});

describe("safehouse command line", () => {
  it("grants the workdir and scratch, mounts git read-only and passes no secrets", () => {
    const cmd = safehouseCommand({ ...plan, settings: { ...plan.settings, envPass: ["DATABASE_URL"], enable: ["docker"] } }, { ...scope, profile: "(deny file-write* (literal \"/x\"))" }, ["/bin/true"]);
    expect(cmd.command).toBe(fake.command);
    expect(cmd.args).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^--workdir=.*work$/),
        expect.stringMatching(/^--add-dirs=.*scratch$/),
        expect.stringMatching(/^--add-dirs-ro=.*objects$/),
        "--env-pass=HOME,USER,LOGNAME,SHELL,LANG,DATABASE_URL",
        "--enable=docker",
        expect.stringMatching(/^--append-profile=.*greview\.sb$/),
      ]),
    );
    const sep = cmd.args.indexOf("--");
    expect(cmd.args.slice(sep + 1, sep + 2)).toEqual(["/usr/bin/env"]);
    expect(cmd.args).toContain(`TMPDIR=${join(scope.scratch, "tmp")}`);
    expect(cmd.args.at(-1)).toBe("/bin/true");
    expect(cmd.env.GREVIEW_TEST_SECRET).toBeUndefined();
    expect(readFileSync(join(scope.scratch, "greview.sb"), "utf8")).toContain("deny file-write*");
  });

  it("protects git config and hooks when .git is inside the workdir", () => {
    const profile = protectGitDirProfile(join(dir, "work", ".git"));
    expect(profile).toContain(`(literal ${JSON.stringify(join(dir, "work", ".git", "config"))})`);
    expect(profile).toContain(`(subpath ${JSON.stringify(join(dir, "work", ".git", "hooks"))})`);
  });
});

describe("sandboxed tools", () => {
  it("runs bash through safehouse with a clean environment and scratch TMPDIR", async () => {
    const tools = sandboxTools(plan, scope);
    expect(tools.map((t) => t.name)).toEqual(["read", "bash"]);
    const out = text(await run(tool(tools, "bash"), { command: 'echo "tmp=$TMPDIR secret=${GREVIEW_TEST_SECRET:-none} ci=$CI"; pwd' }));
    expect(out).toContain(`tmp=${join(scope.scratch, "tmp")}`);
    expect(out).toContain("secret=none");
    expect(out).toContain("ci=1");
    expect(out).toContain(scope.workdir);
    const call = fake.calls().at(-1)!;
    expect(call.args.slice(-3)).toEqual(["/bin/bash", "-c", 'echo "tmp=$TMPDIR secret=${GREVIEW_TEST_SECRET:-none} ci=$CI"; pwd']);
  });

  it("reports failing commands and kills what they leave running", async () => {
    const bash = tool(sandboxTools(plan, scope), "bash");
    const failed = await run(bash, { command: "echo broken; exit 3" });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toMatch(/broken[\s\S]*exited with code 3/);
    const started = Date.now();
    const out = text(await run(bash, { command: "sleep 30 & echo started" }));
    expect(out).toContain("started");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("times out long commands", async () => {
    const bash = tool(sandboxTools(plan, scope), "bash");
    await expect(run(bash, { command: "sleep 20", timeout: 1 })).rejects.toThrow(/timed out after 1 seconds/);
  });

  it("reads files through the sandbox", async () => {
    const read = tool(sandboxTools(plan, scope), "read");
    expect(text(await run(read, { path: "a.txt" }))).toContain("inside");
    expect(fake.calls().some((c) => c.args.includes("/bin/cat"))).toBe(true);
  });

  it("confines read-only tools to the checkout, through symlinks too", async () => {
    const tools = sandboxTools({ kind: "readonly", settings: { mode: "readonly" } }, scope);
    expect(tools.map((t) => t.name)).toEqual(["read", "grep", "find", "ls"]);
    symlinkSync(join(dir, "outside.txt"), join(scope.workdir, "link.txt"));
    const read = tool(tools, "read");
    expect(text(await run(read, { path: "a.txt" }))).toContain("inside");
    await expect(run(read, { path: "../outside.txt" })).rejects.toThrow(/outside the checkout/);
    await expect(run(read, { path: "link.txt" })).rejects.toThrow(/outside the checkout/);
    await expect(run(read, { path: join(dir, "outside.txt") })).rejects.toThrow(/outside the checkout/);
    await expect(run(tool(tools, "ls"), { path: ".." })).rejects.toThrow(/outside the checkout/);
    expect(fake.calls()).toEqual([]);
  });
});

describe("interactive /review", () => {
  function fakePi() {
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    return {
      tools,
      commands,
      api: {
        registerTool: (t: any) => tools.set(t.name, t),
        registerCommand: (n: string, c: any) => commands.set(n, c),
        registerFlag: () => {},
        getFlag: () => undefined,
        sendUserMessage: () => {},
      },
    };
  }

  it("leaves bash alone until /review starts, then sandboxes it", async () => {
    const pi = fakePi();
    createReviewExtension({ file: join(dir, "x.review.json"), sandboxPlan: plan })(pi.api as any);
    const bash = pi.tools.get("bash");
    const sessionManager = { getSessionId: () => "s1", getSessionFile: () => undefined, getSessionDir: () => dir };
    const ctx = { cwd: scope.workdir, hasUI: false, sessionManager };
    expect(text(await bash.execute("1", { command: "echo ${GREVIEW_TEST_SECRET}" }, undefined, undefined, ctx))).toContain("sk-should-not-leak");
    expect(fake.calls()).toEqual([]);
    // /review needs a git repository to make a review file; reuse one from the core helpers.
    const { makeRepo } = await import("../../core/test/helpers.ts");
    const r = makeRepo();
    try {
      await pi.commands.get("review").handler("main..feature", { cwd: r.root, hasUI: false, model: undefined });
      const out = text(await bash.execute("2", { command: "echo ${GREVIEW_TEST_SECRET:-none}" }, undefined, undefined, { cwd: r.root, hasUI: false }));
      expect(out).toContain("none");
      const call = fake.calls().at(-1)!;
      expect(call.args.find((a: string) => a.startsWith("--append-profile="))).toBeDefined();
    } finally {
      r.cleanup();
    }
  });

  it("turns bash off during /review when only read-only is possible", async () => {
    const pi = fakePi();
    createReviewExtension({ file: join(dir, "x.review.json"), sandboxPlan: { kind: "readonly", settings: { mode: "auto" }, note: "safehouse was not found." } })(pi.api as any);
    const { makeRepo } = await import("../../core/test/helpers.ts");
    const r = makeRepo();
    try {
      await pi.commands.get("review").handler("main..feature", { cwd: r.root, hasUI: false });
      await expect(pi.tools.get("bash").execute("1", { command: "true" }, undefined, undefined, { cwd: r.root })).rejects.toThrow(/bash is off during \/review/);
    } finally {
      r.cleanup();
    }
  });
});
