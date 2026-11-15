import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initReview, readReview, writeReview } from "@reviewexplainer/core";
import { parsePatch, validateReview, type ReviewFile } from "@reviewexplainer/format";
import { makeRepo } from "../../core/test/helpers.ts";
import { createReviewExtension, parseReviewArgs, reviewPrompt } from "../src/index.ts";

type Registered = { execute: (...args: any[]) => Promise<any>; name: string; parameters: unknown };

function fakePi(flags: Record<string, string> = {}) {
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
  const ctx = { model: { id: "test-model", provider: "faux" }, cwd: "/", hasUI: false };
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
  const pi = fakePi();
  createReviewExtension({ file })(pi.api as any);
  return { pi, file, review, root: repo.root };
}

describe("pi extension tools", () => {
  it("registers the tools and the /review command", async () => {
    const { pi } = await setup();
    expect([...pi.tools.keys()]).toEqual([
      "review_files",
      "review_show_hunk",
      "review_set_steps",
      "review_overview",
      "review_annotate",
      "review_comment",
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
  });
});
