import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  GitHubClient,
  readReview,
  type GitHubRepo,
  type GitHubReview,
  type GitHubReviewComment,
  type PullRequestDetails,
  type PullRequestInfo,
  type SearchHit,
} from "@reviewexplainer/core";
import { validateReview } from "@reviewexplainer/format";
import { commit, makeRepo, write } from "../../core/test/helpers.ts";
import { parseWatchConfig, Watcher, type WatchConfig } from "../src/index.ts";

interface FakePr {
  number: number;
  title: string;
  headSha: string;
  baseSha: string;
  state: "open" | "closed";
  merged: boolean;
  fork: boolean;
  updatedAt: string;
}

/** A GitHub API stand-in: search results, PR details and review comments. */
class FakeGitHub extends GitHubClient {
  prs = new Map<number, FakePr>();
  matching = new Set<number>();
  comments: GitHubReviewComment[] = [];

  constructor() {
    super("token", (() => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch);
  }

  override async searchPullRequests(): Promise<SearchHit[]> {
    return [...this.matching].map((n) => {
      const pr = this.prs.get(n)!;
      return { owner: "acme", repo: "app", number: n, updatedAt: pr.updatedAt, title: pr.title };
    });
  }

  private pr(n: number): FakePr {
    const pr = this.prs.get(n);
    if (!pr) throw new Error(`GitHub GET /repos/acme/app/pulls/${n} failed: 404 Not Found`);
    return pr;
  }

  override async pullRequest(_repo: GitHubRepo, n: number): Promise<PullRequestInfo> {
    const pr = this.pr(n);
    return {
      number: n,
      title: pr.title,
      url: `https://github.com/acme/app/pull/${n}`,
      author: "dana",
      baseRef: "main",
      baseSha: pr.baseSha,
      headRef: "feature",
      headSha: pr.headSha,
    };
  }

  override async pullRequestDetails(repo: GitHubRepo, n: number): Promise<PullRequestDetails> {
    const pr = this.pr(n);
    return {
      ...(await this.pullRequest(repo, n)),
      state: pr.state,
      merged: pr.merged,
      draft: false,
      isFork: pr.fork,
      cloneUrl: "https://github.com/acme/app.git",
      updatedAt: pr.updatedAt,
    };
  }

  override async reviewComments(): Promise<GitHubReviewComment[]> {
    return this.comments;
  }

  override async reviews(): Promise<GitHubReview[]> {
    return [];
  }

  touch(n: number, patch: Partial<FakePr> = {}) {
    const pr = this.pr(n);
    this.prs.set(n, { ...pr, ...patch, updatedAt: new Date(Date.parse(pr.updatedAt) + 60_000).toISOString() });
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const cleanups: (() => void)[] = [];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "greview-watch-"));
  process.env.XDG_CACHE_HOME = join(home, "cache");
  process.env.XDG_CONFIG_HOME = join(home, "config");
  process.env.PI_CODING_AGENT_DIR = join(home, "pi");
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  rmSync(home, { recursive: true, force: true });
});

function lastUserText(context: any): string {
  const users = context.messages.filter((m: any) => m.role === "user");
  return JSON.stringify(users.at(-1)?.content ?? "");
}

async function setup(opts: { settleSeconds?: number } = {}) {
  const work = makeRepo();
  cleanups.push(work.cleanup);
  const remote = join(home, "remote.git");
  execFileSync("git", ["clone", "--quiet", "--bare", work.root, remote]);
  const head = git(work.root, "rev-parse", "feature");
  const base = git(work.root, "rev-parse", "main");
  git(remote, "update-ref", "refs/pull/1/head", head);
  git(remote, "update-ref", "refs/pull/2/head", head);

  const github = new FakeGitHub();
  const t0 = "2026-11-15T10:00:00Z";
  github.prs.set(1, { number: 1, title: "Add email to users", headSha: head, baseSha: base, state: "open", merged: false, fork: false, updatedAt: t0 });
  github.prs.set(2, { number: 2, title: "Drive-by from a fork", headSha: head, baseSha: base, state: "open", merged: false, fork: true, updatedAt: t0 });
  github.matching = new Set([1, 2]);

  const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted" }] });
  const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);

  const config: WatchConfig = parseWatchConfig({
    filters: [{ name: "mine", query: "is:open review-requested:@me" }],
    settleSeconds: opts.settleSeconds ?? 0,
    retainDays: 7,
    root: join(home, "watch"),
  });
  let clock = new Date("2026-11-15T10:00:00Z");
  const logs: string[] = [];
  const watcher = new Watcher({
    config,
    client: github,
    log: (l) => logs.push(l),
    now: () => clock,
    remoteUrl: () => remote,
    ai: { sessionOverrides: { modelRuntime: runtime, model: faux.getModel() } },
  });

  const push = (files: Record<string, string>) => {
    write(work.root, files);
    const sha = commit(work.root, "more");
    git(work.root, "push", "--quiet", remote, "feature");
    git(remote, "update-ref", "refs/pull/1/head", sha);
    github.touch(1, { headSha: sha });
    return sha;
  };
  const advance = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };
  return { work, remote, github, faux, watcher, config, logs, head, push, advance };
}

describe("parseWatchConfig", () => {
  it("fills defaults and rejects bad settings", () => {
    const c = parseWatchConfig({ filters: [{ query: "is:open author:@me" }] });
    expect(c).toMatchObject({ intervalSeconds: 120, settleSeconds: 180, concurrency: 1, retainDays: 7 });
    expect(c.filters[0]).toEqual({ name: "filter 1", query: "is:open author:@me", ai: true, findings: true });
    expect(() => parseWatchConfig(undefined)).toThrow(/No "watch" settings/);
    expect(() => parseWatchConfig({ filters: [] })).toThrow(/at least one/);
    expect(() => parseWatchConfig({ filters: [{ query: "x" }], intervalSeconds: 1 })).toThrow(/intervalSeconds/);
  });
});

describe("Watcher", () => {
  it("sets up a worktree and an AI review for a new PR, and skips forks", async () => {
    const { watcher, github, faux, head } = await setup();
    github.comments = [
      {
        id: 7,
        path: "src/types.ts",
        body: "Why optional?",
        user: { login: "priya" },
        created_at: "2026-11-15T09:00:00Z",
        html_url: "https://github.com/acme/app/pull/1#discussion_r7",
        commit_id: head,
        original_commit_id: head,
        line: 4,
        start_line: null,
        side: "RIGHT",
        start_side: null,
        original_line: 4,
        original_start_line: null,
        diff_hunk: "",
      },
    ];
    const prompts: string[] = [];
    faux.setResponses([
      (context: any) => {
        prompts.push(lastUserText(context));
        return fauxAssistantMessage(
          [
            // Read a file outside the diff through the worktree, then record a finding.
            fauxToolCall("read", { path: "src/api.ts" }),
            fauxToolCall("review_comment", { path: "src/service.ts", start: 4, body: "Email is not escaped.", severity: "major" }),
          ],
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage([fauxText("One finding.")]),
    ]);

    const s = await watcher.tick();
    expect(s.started).toEqual(["acme/app#1"]);
    expect(s.skipped).toEqual(["acme/app#2"]);
    await watcher.drain();

    const rec = watcher.state.get("acme/app#1")!;
    expect(rec).toMatchObject({ status: "ready", headSha: head, reviewedHead: head, job: "review", lastSummary: "One finding." });
    expect(existsSync(rec.sessionFile!)).toBe(true);
    expect(git(rec.worktree!, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(rec.worktree!, "src/api.ts"), "utf8")).toContain("email");
    expect(prompts[0]).toContain("checkout of the PR head");

    const review = readReview(rec.reviewFile!);
    expect(validateReview(review).errors).toEqual([]);
    expect(review.threads.map((t) => [t.source, t.id.startsWith("gh_") ? "gh" : "ai"])).toEqual([
      ["github", "gh"],
      ["ai", "ai"],
    ]);
    expect(watcher.state.get("acme/app#2")).toMatchObject({ status: "skipped", skipReason: "from a fork" });
    expect(existsSync(watcher.worktrees.path("acme", "app", 2))).toBe(false);

    // Nothing changed: nothing to do.
    const again = await watcher.tick();
    expect(again.started.length + again.synced.length + again.queued.length).toBe(0);
  });

  it("re-reviews a push in the same session, after the push settles", async () => {
    const { watcher, faux, push, advance, config, head } = await setup({ settleSeconds: 300 });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("review_comment", { path: "src/api.ts", start: 4, body: "id is hard-coded.", severity: "minor" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("First review done.")]),
    ]);
    await watcher.tick();
    await watcher.drain();
    const first = watcher.state.get("acme/app#1")!;

    const newHead = push({
      "src/api.ts": 'import { greet } from "./service";\n\nexport function handler(name: string, email?: string, id = "1") {\n  return greet({ id, name, email });\n}\n',
    });
    let s = await watcher.tick();
    expect(s.synced).toEqual(["acme/app#1"]);
    expect(s.refreshed).toEqual([]);
    expect(watcher.state.get("acme/app#1")).toMatchObject({ status: "ready", pendingHead: newHead });

    let seen: { prompt: string; messages: number } | undefined;
    faux.setResponses([
      (context: any) => {
        seen = { prompt: lastUserText(context), messages: context.messages.length };
        const review = readReview(first.reviewFile!);
        const mine = review.threads.find((t) => t.source === "ai")!;
        return fauxAssistantMessage([fauxToolCall("review_resolve", { thread: mine.id, note: "Fixed: id is a parameter now." })], {
          stopReason: "toolUse",
        });
      },
      fauxAssistantMessage([fauxText("The hard-coded id was fixed.")]),
    ]);
    advance(config.settleSeconds + 1);
    s = await watcher.tick();
    expect(s.refreshed).toEqual(["acme/app#1"]);
    await watcher.drain();

    const rec = watcher.state.get("acme/app#1")!;
    expect(rec).toMatchObject({ status: "ready", headSha: newHead, reviewedHead: newHead, job: "rereview", previousHead: head });
    expect(rec.sessionFile).toBe(first.sessionFile);
    expect(rec.pendingHead).toBeUndefined();
    expect(git(rec.worktree!, "rev-parse", "HEAD")).toBe(newHead);
    expect(seen!.prompt).toContain("needs a re-review");
    expect(seen!.prompt).toContain(`head moved from ${head.slice(0, 12)} to ${newHead.slice(0, 12)}`);
    // The earlier conversation is still there.
    expect(seen!.messages).toBeGreaterThan(4);
    const review = readReview(rec.reviewFile!);
    expect(review.subject.head.sha).toBe(newHead);
    expect(review.threads.find((t) => t.source === "ai")!.status).toBe("resolved");
    expect(validateReview(review).errors).toEqual([]);
  });

  it("pauses unmatched PRs, and cleans up closed ones", async () => {
    const { watcher, github, faux, advance } = await setup();
    faux.setResponses([fauxAssistantMessage([fauxText("Done.")])]);
    await watcher.tick();
    await watcher.drain();
    const rec = watcher.state.get("acme/app#1")!;

    github.matching.delete(1);
    let s = await watcher.tick();
    expect(s.paused).toEqual(["acme/app#1"]);
    expect(existsSync(rec.worktree!)).toBe(true);

    github.matching.add(1);
    await watcher.tick();
    expect(watcher.state.get("acme/app#1")!.status).toBe("ready");

    github.matching.delete(1);
    github.touch(1, { state: "closed", merged: true });
    s = await watcher.tick();
    expect(s.closed).toEqual(["acme/app#1"]);
    expect(existsSync(rec.worktree!)).toBe(false);
    expect(watcher.state.get("acme/app#1")).toMatchObject({ status: "closed", merged: true });
    expect(existsSync(rec.reviewFile!)).toBe(true);
    expect(git(watcher.worktrees.mirror("acme", "app"), "worktree", "list")).not.toContain("pr-1");

    advance(8 * 24 * 3600);
    s = await watcher.tick();
    expect(s.purged).toEqual(["acme/app#1"]);
    expect(existsSync(rec.reviewFile!)).toBe(false);
    expect(existsSync(rec.sessionFile!)).toBe(false);
    expect(watcher.state.get("acme/app#1")).toBeUndefined();
  });

  it("recovers after a crash: requeues interrupted runs and removes orphaned worktrees", async () => {
    const { watcher, faux } = await setup();
    faux.setResponses([fauxAssistantMessage([fauxText("Done.")])]);
    await watcher.tick();
    await watcher.drain();
    const rec = watcher.state.get("acme/app#1")!;
    watcher.state.put({ ...rec, status: "reviewing" });
    const orphan = watcher.worktrees.path("acme", "app", 99);
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "junk"), "x");

    const notes = await watcher.recover();
    expect(notes).toContain("acme/app#1: AI run was interrupted; queued again");
    expect(notes.some((n) => n.includes("pr-99"))).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(rec.worktree!)).toBe(true);
    expect(watcher.state.get("acme/app#1")!.status).toBe("queued");
  });

  it("resets the worktree before each AI run", async () => {
    const { watcher, faux } = await setup();
    faux.setResponses([fauxAssistantMessage([fauxText("Done.")])]);
    await watcher.tick();
    await watcher.drain();
    const rec = watcher.state.get("acme/app#1")!;
    writeFileSync(join(rec.worktree!, "src/types.ts"), "tampered");
    writeFileSync(join(rec.worktree!, "stray.txt"), "x");
    watcher.state.put({ ...rec, status: "queued" });
    faux.setResponses([fauxAssistantMessage([fauxText("Again.")])]);
    await watcher.tick();
    await watcher.drain();
    expect(readFileSync(join(rec.worktree!, "src/types.ts"), "utf8")).toContain("email?: string");
    expect(existsSync(join(rec.worktree!, "stray.txt"))).toBe(false);
  });
});
