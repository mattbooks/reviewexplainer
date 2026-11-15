import { afterEach, describe, expect, it } from "vitest";
import {
  makeLinesAnchor,
  parsePatch,
  validateReview,
  type ReviewFile,
  type Thread,
} from "@reviewexplainer/format";
import {
  buildPendingReview,
  diffHunkTail,
  extractImports,
  GitHubClient,
  initReview,
  parseGitHubRemote,
  parseRange,
  pushPendingReview,
  refreshFromGit,
  resolveImport,
  reviewPath,
  roleForPath,
  syncGitHub,
  threadsFromGitHub,
  type GitHubReviewComment,
} from "../src/index.ts";
import { commit, makeRepo, sh, write } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function repo() {
  const r = makeRepo();
  cleanups.push(r.cleanup);
  return r.root;
}

function localThread(review: ReviewFile, id: string, path: string, line: number, body = "Looks off"): Thread {
  const model = parsePatch(review.patch);
  return {
    id,
    source: "local",
    status: "open",
    anchor: makeLinesAnchor(model, { path, side: "new", start: line, commit: review.subject.head.sha }),
    comments: [{ id: `${id}_c`, author: { name: "me", kind: "human" }, body, createdAt: "2026-11-15T00:00:00Z" }],
  };
}

describe("roles and imports", () => {
  it("classifies paths", () => {
    expect(roleForPath("package-lock.json")).toBe("lockfile");
    expect(roleForPath("src/__tests__/a.ts")).toBe("test");
    expect(roleForPath("pkg/foo_test.go")).toBe("test");
    expect(roleForPath("docs/guide.md")).toBe("docs");
    expect(roleForPath("vendor/x/y.go")).toBe("vendored");
    expect(roleForPath("api/gen/client.pb.go")).toBe("generated");
    expect(roleForPath(".github/workflows/ci.yml")).toBe("config");
    expect(roleForPath("src/app.ts")).toBe("source");
    expect(roleForPath("src/app.ts", new Set(["linguist-generated"]))).toBe("generated");
  });

  it("resolves relative imports to changed files", () => {
    const changed = new Set(["src/a.ts", "src/lib/index.ts", "pkg/mod.py", "pkg/sub/__init__.py"]);
    expect(extractImports("src/b.ts", 'import { x } from "./a.js";\nexport * from "./lib";\nconst y = require("react");')).toEqual([
      "./a.js",
      "./lib",
      "react",
    ]);
    expect(resolveImport("src/b.ts", "./a.js", changed)).toBe("src/a.ts");
    expect(resolveImport("src/b.ts", "./lib", changed)).toBe("src/lib/index.ts");
    expect(resolveImport("src/b.ts", "react", changed)).toBeUndefined();
    expect(resolveImport("pkg/other.py", ".mod", changed)).toBe("pkg/mod.py");
    expect(resolveImport("app.py", "pkg.sub", changed)).toBe("pkg/sub/__init__.py");
    const workspace = new Set(["packages/format/src/index.ts", "packages/core/src/a.ts"]);
    expect(resolveImport("packages/core/src/a.ts", "@acme/format", workspace)).toBe("packages/format/src/index.ts");
    expect(resolveImport("packages/core/src/a.ts", "@acme/other", workspace)).toBeUndefined();
  });

  it("parses ranges and remotes", () => {
    expect(parseRange("main..feature")).toEqual({ base: "main", head: "feature" });
    expect(parseRange("main...HEAD")).toEqual({ base: "main", head: "HEAD" });
    expect(parseRange("main")).toEqual({ base: "main" });
    expect(parseGitHubRemote("git@github.com:mattbooks/reviewexplainer.git")).toEqual({ owner: "mattbooks", name: "reviewexplainer" });
    expect(parseGitHubRemote("https://github.com/a/b")).toEqual({ owner: "a", name: "b" });
  });
});

describe("initReview", () => {
  it("orders a branch by role and import dependencies", async () => {
    const root = repo();
    const { review } = await initReview({ cwd: root, range: "main..feature" });
    expect(validateReview(review)).toMatchObject({ ok: true, errors: [] });
    expect(review.guide.generatedBy).toBe("heuristic");
    const order = review.guide.steps.map((s) => [s.id, s.items.map((i) => i.path)]);
    expect(order).toEqual([
      ["definitions", ["src/types.ts"]],
      ["core", ["src/service.ts"]],
      ["callers", ["src/api.ts", "src/standalone.ts"]],
      ["tests", ["test/service.test.ts"]],
      ["docs", ["README.md"]],
      ["mechanical", ["package-lock.json", "src/gen/client.generated.ts"]],
    ]);
    expect(review.files.find((f) => f.path === "package-lock.json")!.role).toBe("lockfile");
    expect(review.subject.base.ref).toBe("main");
    expect(review.guide.overview).toContain("8 files changed");
  });

  it("can embed full file contents", async () => {
    const root = repo();
    const { review } = await initReview({ cwd: root, range: "main..feature", withBlobs: true });
    expect(review.blobs!["src/types.ts"]!.new).toContain("email?: string");
    expect(review.blobs!["src/types.ts"]!.old).not.toContain("email");
  });
});

describe("refresh", () => {
  it("keeps the guide, flags new hunks and re-anchors threads", async () => {
    const root = repo();
    let { review } = await initReview({ cwd: root, range: "main..feature" });
    const serviceHunks = review.files.find((f) => f.path === "src/service.ts")!.hunks;
    expect(serviceHunks.length).toBe(2);
    review = {
      ...review,
      threads: [
        localThread(review, "t_keep", "src/service.ts", 25, "pad20 changed"),
        localThread(review, "t_gone", "src/api.ts", 4, "will be rewritten"),
      ],
      state: { viewed: { [serviceHunks[1]!.id]: { at: "now" }, [serviceHunks[0]!.id]: { at: "now" } } },
    };
    expect(validateReview(review).errors).toEqual([]);

    // New commit: shift service.ts down by three lines, rewrite api.ts line 4, add a file.
    sh(root, "checkout", "-q", "feature");
    const service = (await import("node:fs")).readFileSync(`${root}/src/service.ts`, "utf8");
    write(root, {
      "src/service.ts": service.replace('import type { User } from "./types";\n', 'import type { User } from "./types";\n// one\n// two\n// three\n'),
      "src/api.ts": 'import { greet } from "./service";\n\nexport function handler(name: string, email?: string) {\n  return greet({ id: "2", name, email }).trim();\n}\n',
      "src/new.ts": "export const fresh = 1;\n",
    });
    commit(root, "more");

    const { review: next, report } = await refreshFromGit(review, { cwd: root });
    expect(validateReview(next)).toMatchObject({ ok: true, errors: [] });
    const keep = next.threads.find((t) => t.id === "t_keep")!;
    expect(keep.status).toBe("open");
    expect(keep.anchor).toMatchObject({ kind: "lines", start: 28, end: 28 });
    expect(next.threads.find((t) => t.id === "t_gone")!.status).toBe("outdated");
    expect(report.relocated).toContain("t_keep");
    expect(report.outdated).toEqual(["t_gone"]);
    // The pad20 hunk is unchanged, so it stays viewed; the first service hunk changed.
    expect(Object.keys(next.state.viewed)).toEqual([serviceHunks[1]!.id]);
    expect(report.newHunks.length).toBeGreaterThan(0);
    const remaining = next.guide.steps.at(-1)!;
    expect(remaining.id).toBe("remaining");
    expect(remaining.items.map((i) => i.path)).toEqual(expect.arrayContaining(["src/new.ts", "src/service.ts", "src/api.ts"]));
  });
});

function fakeGitHub(routes: Record<string, (body?: any) => unknown>) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.github.com", "").replace(/[?&]per_page=100&page=\d+$/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const handler = routes[`${method} ${path}`];
    if (!handler) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(handler(body)), { status: 200 });
  }) as unknown as typeof fetch;
  return { client: new GitHubClient("token", impl), calls };
}

function ghComment(partial: Partial<GitHubReviewComment> & Pick<GitHubReviewComment, "id" | "path" | "body">): GitHubReviewComment {
  return {
    user: { login: "octocat" },
    created_at: `2026-11-10T00:00:0${partial.id % 10}Z`,
    html_url: `https://github.com/o/r/pull/1#discussion_r${partial.id}`,
    commit_id: "head",
    original_commit_id: "head",
    line: null,
    start_line: null,
    side: "RIGHT",
    start_side: null,
    original_line: null,
    original_start_line: null,
    diff_hunk: "",
    ...partial,
  };
}

describe("GitHub", () => {
  it("maps review comments into threads, relocating outdated ones by content", async () => {
    const root = repo();
    const { review } = await initReview({ cwd: root, range: "main..feature" });
    const comments: GitHubReviewComment[] = [
      ghComment({ id: 1, path: "src/types.ts", body: "Optional?", line: 4 }),
      ghComment({ id: 2, path: "src/types.ts", body: "Yes, on purpose", in_reply_to_id: 1 }),
      ghComment({
        id: 3,
        path: "src/service.ts",
        body: "Was this meant to change?",
        original_line: 18,
        diff_hunk: "@@ -18,7 +18,7 @@ export const pad16 = 16;\n export const pad17 = 17;\n export const pad18 = 18;\n export const pad19 = 19;\n-export const pad20 = 20;\n+export const pad20 = 2000;",
      }),
      ghComment({ id: 4, path: "src/api.ts", body: "Gone", original_line: 9, diff_hunk: "@@ -9 +9 @@\n+vanished line" }),
      ghComment({ id: 5, path: "README.md", body: "File level", subject_type: "file" }),
    ];
    const threads = threadsFromGitHub(review, comments, [
      { id: 9, body: "Nice work", user: { login: "rev" }, state: "APPROVED", html_url: "u", submitted_at: "2026-11-11T00:00:00Z" },
    ]);
    expect(threads.map((t) => [t.id, t.status, t.anchor.kind, t.comments.length])).toEqual([
      ["gh_1", "open", "lines", 2],
      ["gh_3", "open", "lines", 1],
      ["gh_4", "outdated", "lines", 1],
      ["gh_5", "open", "file", 1],
      ["ghr_9", "open", "review", 1],
    ]);
    expect(threads[1]!.anchor).toMatchObject({ start: 25, end: 25, side: "new" });
    expect(diffHunkTail("@@ -1,2 +1,2 @@\n a\n-b\n+c", "old", 2)).toEqual(["a", "b"]);
  });

  it("syncs and keeps local resolved status", async () => {
    const root = repo();
    let { review } = await initReview({ cwd: root, range: "main..feature" });
    review = {
      ...review,
      subject: { ...review.subject, repo: { owner: "o", name: "r" }, pr: { number: 1, url: "https://github.com/o/r/pull/1", title: "t", author: "a" } },
    };
    const { client } = fakeGitHub({
      "GET /repos/o/r/pulls/1/comments": () => [ghComment({ id: 1, path: "src/types.ts", body: "Optional?", line: 4 })],
      "GET /repos/o/r/pulls/1/reviews": () => [],
    });
    const first = await syncGitHub(review, client);
    expect(first.added).toBe(1);
    const resolved = { ...first.review, threads: first.review.threads.map((t) => ({ ...t, status: "resolved" as const })) };
    const second = await syncGitHub(resolved, client);
    expect(second.added).toBe(0);
    expect(second.review.threads[0]!.status).toBe("resolved");
    expect(validateReview(second.review).errors).toEqual([]);
  });

  it("pushes open local threads as a pending review", async () => {
    const root = repo();
    let { review } = await initReview({ cwd: root, range: "main..feature" });
    const model = parsePatch(review.patch);
    const hunk = model.byPath.get("src/api.ts")!.hunks[0]!;
    review = {
      ...review,
      subject: { ...review.subject, repo: { owner: "o", name: "r" }, pr: { number: 1, url: "https://github.com/o/r/pull/1", title: "t", author: "a" } },
      threads: [
        { ...localThread(review, "t1", "src/types.ts", 4, "Document this field"), severity: "minor", suggestion: { replacement: "  email?: string; // optional" } },
        {
          id: "t2",
          source: "local",
          status: "open",
          anchor: { kind: "hunk", path: "src/api.ts", hunk: hunk.id },
          comments: [{ id: "c2", author: { name: "me", kind: "human" }, body: "Hunk note", createdAt: "x" }],
        },
        {
          id: "t3",
          source: "local",
          status: "open",
          anchor: { kind: "review" },
          comments: [{ id: "c3", author: { name: "me", kind: "human" }, body: "Overall fine", createdAt: "x" }],
        },
        { ...localThread(review, "t4", "src/types.ts", 4, "already resolved"), status: "resolved" },
      ],
    };
    const payload = buildPendingReview(review);
    expect(payload.threadIds).toEqual(["t1", "t2", "t3"]);
    expect(payload.comments[0]).toMatchObject({ path: "src/types.ts", line: 4, side: "RIGHT" });
    expect(payload.comments[0]!.body).toContain("```suggestion");
    expect(payload.comments[1]).toMatchObject({ path: "src/api.ts", line: 5, side: "RIGHT" });
    expect(payload.body).toContain("Overall fine");

    const { client, calls } = fakeGitHub({
      "POST /repos/o/r/pulls/1/reviews": () => ({ id: 77, html_url: "https://github.com/o/r/pull/1#pullrequestreview-77" }),
      "GET /repos/o/r/pulls/1/reviews/77/comments": () => [
        ghComment({ id: 501, path: "src/api.ts", body: payload.comments[1]!.body, line: 5 }),
        ghComment({ id: 500, path: "src/types.ts", body: payload.comments[0]!.body, line: 4 }),
      ],
    });
    const pushed = await pushPendingReview(client, { owner: "o", name: "r" }, review);
    expect(pushed.pushed).toBe(3);
    expect(pushed.url).toBe("https://github.com/o/r/pull/1/files");
    expect(calls[0]!.body).not.toHaveProperty("event");
    expect(calls[0]!.body).not.toHaveProperty("threadIds");
    const byId = Object.fromEntries(pushed.review.threads.map((t) => [t.id, t.external?.github?.commentIds]));
    expect(byId).toEqual({ t1: [500], t2: [501], t3: [], t4: undefined });
    expect(buildPendingReview(pushed.review).threadIds).toEqual([]);
  });
});

describe("storage paths", () => {
  it("follows the configured mode", () => {
    const key = { owner: "o", repo: "r", pr: 12, head: "abcdef1234567890" };
    process.env.XDG_CACHE_HOME = "/cache";
    expect(reviewPath({ storage: "cache" }, key)).toBe("/cache/greview/o/r/pr-12.review.json");
    expect(reviewPath({ storage: "repo" }, key, "/repo")).toBe("/repo/.reviews/pr-12.review.json");
    expect(reviewPath({ storage: "path", path: "out/{repo}-{name}.review.json.gz" }, key, "/repo")).toBe(
      "/repo/out/r-pr-12.review.json.gz",
    );
    expect(reviewPath({ storage: "cache" }, { head: "abcdef1234567890" })).toBe("/cache/greview/local/repo/abcdef123456.review.json");
  });
});
