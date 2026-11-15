import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initReview, readReview, writeReview } from "@reviewexplainer/core";
import { parsePatch, validateReview, type ReviewFile } from "@reviewexplainer/format";
import { makeRepo } from "../../core/test/helpers.ts";
import { createReviewExtension, parseReviewArgs, rereviewPrompt, reviewPrompt } from "../src/index.ts";

type Registered = { execute: (...args: any[]) => Promise<any>; name: string; parameters: unknown };

function fakePi(flags: Record<string, string> = {}, cwd = "/") {
  const tools = new Map<string, Registered>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const messages: string[] = [];
  const api = {
    registerTool: (t: Registered) => tools.set(t.name, t),
    registerCommand: (name: string, c: any) => commands.set(name, c),
    registerFlag: () => {},
    getFlag: (name: string) => flags[name],
    sendUserMessage: (m: string) => messages.push(m),
  };
  const ctx = { model: { id: "test-model", provider: "faux" }, cwd, hasUI: false };
  const call = async (name: string, params: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    const res = await tool.execute("id", params, undefined, undefined, ctx);
    return res.content[0].text as string;
  };
  return { api, tools, commands, messages, call };
}

const cleanups: (() => void)[] = [];
let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "greview-cache-"));
  process.env.XDG_CACHE_HOME = cacheDir;
  process.env.XDG_CONFIG_HOME = cacheDir;
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  rmSync(cacheDir, { recursive: true, force: true });
});

async function setup() {
  const repo = makeRepo();
  cleanups.push(repo.cleanup);
  const { review } = await initReview({ cwd: repo.root, range: "main..feature" });
  const file = join(cacheDir, "test.review.json");
  writeReview(file, review);
  const pi = fakePi({}, repo.root);
  createReviewExtension({ file })(pi.api as any);
  return { pi, file, review, root: repo.root };
}

describe("pi extension tools", () => {
  it("registers the tools and the /review command", async () => {
    const { pi } = await setup();
    expect([...pi.tools.keys()]).toEqual([
      "review_files",
      "review_show_hunk",
      "review_git_show",
      "review_set_steps",
      "review_overview",
      "review_annotate",
      "review_comment",
      "review_resolve",
    ]);
    expect(pi.commands.has("review")).toBe(true);
  });

  it("lists files and shows numbered hunks", async () => {
    const { pi, review } = await setup();
    const files = await pi.call("review_files", {});
    expect(files).toContain("src/types.ts");
    expect(files).toContain(review.files.find((f) => f.path === "src/types.ts")!.hunks[0]!.id);
    const hunk = await pi.call("review_show_hunk", { path: "src/types.ts" });
    expect(hunk).toMatch(/\n\s+3\s+4 \+   email\?: string;/);
    expect(hunk).toContain(" row   old   new");
  });

  it("rejects incomplete steps, then saves a full ordering with slices", async () => {
    const { pi, file, review } = await setup();
    const model = parsePatch(review.patch);
    const service = model.byPath.get("src/service.ts")!;
    const first = service.hunks[0]!;
    await expect(
      pi.call("review_set_steps", {
        steps: [{ id: "one", title: "One", narrative: "n", items: [{ path: "src/types.ts", hunks: "all" }] }],
      }),
    ).rejects.toThrow(/not in any step/);

    const rest = review.files.filter((f) => f.path !== "src/types.ts" && f.path !== "src/service.ts");
    const steps = [
      { id: "shape", title: "User gets an email", kind: "context", narrative: "Optional email field.", items: [{ path: "src/types.ts", hunks: "all" }] },
      {
        id: "greet",
        title: "Greeting includes email",
        kind: "core",
        narrative: "greet appends the email.",
        dependsOn: ["shape"],
        items: [
          {
            path: "src/service.ts",
            hunks: service.hunks.slice(1).map((h) => h.id),
            slices: [
              { hunk: first.id, rows: [0, 2] },
              { hunk: first.id, rows: [3, first.rows.length - 1] },
            ],
          },
        ],
      },
      { id: "rest", title: "Everything else", narrative: "The rest.", items: rest.map((f) => ({ path: f.path, hunks: "all" })) },
    ];
    expect(await pi.call("review_set_steps", { steps })).toMatch(/Saved 3 steps/);
    const saved = readReview(file);
    expect(saved.guide.generatedBy).toBe("ai");
    expect(saved.guide.steps.map((s) => s.id)).toEqual(["shape", "greet", "rest"]);
    expect(validateReview(saved).errors).toEqual([]);
  });

  it("records overview, annotations and comments with anchors", async () => {
    const { pi, file } = await setup();
    await pi.call("review_overview", { summary: "Adds email to users." });
    await pi.call("review_annotate", { path: "src/types.ts", start: 4, body: "New optional field." });
    await pi.call("review_comment", {
      path: "src/service.ts",
      start: 4,
      body: "Email is not escaped.",
      severity: "major",
      category: "security",
      suggestion: '  return "hello " + u.name;',
    });
    await pi.call("review_comment", { body: "Consider a changelog entry.", severity: "nit" });
    await expect(pi.call("review_comment", { path: "src/service.ts", start: 15, body: "x", severity: "nit" })).rejects.toThrow(
      /not in the diff/,
    );
    await expect(pi.call("review_comment", { path: "src/types.ts", hunk: "deadbeef00", body: "x", severity: "nit" })).rejects.toThrow(
      /Its hunks are/,
    );
    const saved: ReviewFile = readReview(file);
    expect(saved.guide.overview).toBe("Adds email to users.");
    expect(saved.annotations[0]).toMatchObject({ source: "ai", anchor: { kind: "lines", path: "src/types.ts", start: 4 } });
    expect(saved.threads).toHaveLength(2);
    expect(saved.threads[0]).toMatchObject({
      source: "ai",
      severity: "major",
      category: "security",
      anchor: { kind: "lines", side: "new", start: 4, end: 4 },
      comments: [{ author: { name: "faux/test-model", kind: "ai" }, ai: { model: "test-model", provider: "faux" } }],
    });
    expect(saved.threads[1]!.anchor).toEqual({ kind: "review" });
    expect(validateReview(saved).errors).toEqual([]);
  });
});

describe("watch-mode tools", () => {
  it("reads any file at head or base", async () => {
    const { pi } = await setup();
    const head = await pi.call("review_git_show", { path: "src/types.ts" });
    expect(head).toContain("at head");
    expect(head).toContain("5 lines");
    expect(head).toContain("    4    email?: string;");
    const base = await pi.call("review_git_show", { path: "src/types.ts", rev: "base" });
    expect(base).not.toContain("email");
    expect(await pi.call("review_git_show", { path: "README.md" })).toContain("Now with emails.");
    await expect(pi.call("review_git_show", { path: "nope.ts" })).rejects.toThrow(/does not exist at head/);
    await expect(pi.call("review_git_show", { path: "src/types.ts", rev: "main; rm -rf /" })).rejects.toThrow(/rev must be/);
  });

  it("resolves only its own findings, and lists unresolved threads", async () => {
    const { pi, file } = await setup();
    await pi.call("review_comment", { path: "src/service.ts", start: 4, body: "Email is not escaped.", severity: "major" });
    const saved = readReview(file);
    const aiThread = saved.threads[0]!;
    writeReview(file, {
      ...saved,
      threads: [
        ...saved.threads,
        { id: "human_1", source: "local", status: "open", anchor: { kind: "review" }, comments: [{ id: "h", author: { name: "Matt", kind: "human" }, body: "Ship it?", createdAt: "x" }] },
      ],
    });
    const listing = await pi.call("review_files", {});
    expect(listing).toContain(`[${aiThread.id}] ai major at src/service.ts:4: Email is not escaped.`);
    expect(listing).toContain("[human_1] local at whole change: Ship it?");
    await expect(pi.call("review_resolve", { thread: "human_1" })).rejects.toThrow(/Only AI threads/);
    await pi.call("review_resolve", { thread: aiThread.id, note: "Escaped in the new commit." });
    const after = readReview(file);
    expect(after.threads[0]).toMatchObject({ status: "resolved", comments: [{}, { body: "Escaped in the new commit.", author: { kind: "ai" } }] });
    expect(after.threads[1]!.status).toBe("open");
  });

  it("does not overwrite edits made by others between tool calls", async () => {
    const { pi, file } = await setup();
    await pi.call("review_overview", { summary: "First." });
    const saved = readReview(file);
    writeReview(file, { ...saved, state: { viewed: { [saved.files[0]!.hunks[0]?.id ?? "x"]: { at: "now" } } } });
    await pi.call("review_overview", { summary: "Second." });
    const after = readReview(file);
    expect(after.guide.overview).toBe("Second.");
    expect(Object.keys(after.state.viewed)).toHaveLength(1);
  });
});

describe("/review command", () => {
  it("creates a review for a range and asks the agent to build the guide", async () => {
    const repo = makeRepo();
    cleanups.push(repo.cleanup);
    const pi = fakePi();
    createReviewExtension()(pi.api as any);
    await pi.commands.get("review")!.handler("main..feature --no-findings", { cwd: repo.root, hasUI: false });
    expect(pi.messages).toHaveLength(1);
    expect(pi.messages[0]).toContain("Pass 1: reading order.");
    expect(pi.messages[0]).not.toContain("Pass 2: findings.");
    expect(await pi.call("review_files", {})).toContain("src/api.ts");
  });

  it("parses its arguments", () => {
    expect(parseReviewArgs("")).toEqual({ findings: true });
    expect(parseReviewArgs("--pr 12 --no-findings")).toEqual({ pr: 12, findings: false });
    expect(parseReviewArgs("main..HEAD")).toEqual({ range: "main..HEAD", findings: true });
    expect(parseReviewArgs("x/pr-1.review.json")).toEqual({ file: "x/pr-1.review.json", findings: true });
    expect(() => parseReviewArgs("--pr abc")).toThrow();
  });

  it("names the head commit in the prompt", async () => {
    const { review } = await setup();
    expect(reviewPrompt(review)).toContain(`git show ${review.subject.head.sha.slice(0, 12)}:<path>`);
    expect(reviewPrompt(review, { worktree: true })).toContain("checkout of the PR head");
    expect(reviewPrompt(review, { worktree: true })).not.toContain("bash");
  });

  it("builds a re-review prompt that points at the previous head", async () => {
    const { review } = await setup();
    const text = rereviewPrompt(review, { previousHead: "abcdef1234567890", newHunks: 2, relocated: 1, outdated: 0 }, { worktree: true });
    expect(text).toContain("head moved from abcdef123456 to");
    expect(text).toContain('rev "abcdef123456"');
    expect(text).toContain("2 new or changed hunks are");
    expect(text).toContain("review_resolve");
  });
});
