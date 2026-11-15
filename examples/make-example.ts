/**
 * Builds examples/session-expiry.review.json: a small but realistic change
 * (adding session expiry to a login flow) with an AI-written guide, AI
 * findings, a GitHub thread and a local comment. Run with:
 *
 *   npx tsx examples/make-example.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initReview, mergeGitHubThreads, threadsFromGitHub, writeReview } from "@reviewexplainer/core";
import { makeLinesAnchor, parsePatch, type ReviewFile } from "@reviewexplainer/format";
import { ALL_TOOLS, type ReviewSession } from "@reviewexplainer/pi-extension";

const root = mkdtempSync(join(tmpdir(), "greview-example-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const write = (files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

git("init", "-q", "-b", "main");
git("config", "user.email", "dev@example.com");
git("config", "user.name", "Dev");
write({
  "src/session/types.ts": `export interface Session {
  id: string;
  userId: string;
  createdAt: Date;
}

export interface SessionStore {
  get(id: string): Promise<Session | undefined>;
  put(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
}
`,
  "src/session/manager.ts": `import { randomUUID } from "node:crypto";
import type { Session, SessionStore } from "./types";

export class SessionManager {
  constructor(private store: SessionStore) {}

  async create(userId: string): Promise<Session> {
    const session = { id: randomUUID(), userId, createdAt: new Date() };
    await this.store.put(session);
    return session;
  }

  async resolve(id: string): Promise<Session | undefined> {
    return this.store.get(id);
  }

  async destroy(id: string): Promise<void> {
    await this.store.delete(id);
  }
}
`,
  "src/http/auth-middleware.ts": `import type { SessionManager } from "../session/manager";

export function requireSession(sessions: SessionManager) {
  return async (req: any, res: any, next: () => void) => {
    const id = req.cookies?.sid;
    const session = id ? await sessions.resolve(id) : undefined;
    if (!session) {
      res.status(401).end();
      return;
    }
    req.session = session;
    next();
  };
}
`,
  "src/http/login.ts": `import type { SessionManager } from "../session/manager";

export async function login(sessions: SessionManager, userId: string, res: any) {
  const session = await sessions.create(userId);
  res.cookie("sid", session.id, { httpOnly: true, sameSite: "lax" });
  return session;
}
`,
  "test/session.test.ts": `import { SessionManager } from "../src/session/manager";
import { memoryStore } from "./helpers";

test("creates and resolves a session", async () => {
  const m = new SessionManager(memoryStore());
  const s = await m.create("u1");
  expect(await m.resolve(s.id)).toEqual(s);
});
`,
  "docs/sessions.md": "# Sessions\n\nSessions are stored server side and identified by the `sid` cookie.\n",
  "package-lock.json": '{\n  "name": "app",\n  "lockfileVersion": 3\n}\n',
});
git("add", "-A");
git("commit", "-q", "-m", "base");
git("checkout", "-q", "-b", "session-expiry");
write({
  "src/session/types.ts": `export interface Session {
  id: string;
  userId: string;
  createdAt: Date;
  /** When the session stops being valid. */
  expiresAt: Date;
}

export interface SessionStore {
  get(id: string): Promise<Session | undefined>;
  put(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
}

export const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 7;
`,
  "src/session/manager.ts": `import { randomUUID } from "node:crypto";
import { DEFAULT_TTL_MS, type Session, type SessionStore } from "./types";

export class SessionManager {
  constructor(
    private store: SessionStore,
    private ttlMs = DEFAULT_TTL_MS,
    private now = () => new Date(),
  ) {}

  async create(userId: string): Promise<Session> {
    const createdAt = this.now();
    const session = { id: randomUUID(), userId, createdAt, expiresAt: new Date(createdAt.getTime() + this.ttlMs) };
    await this.store.put(session);
    return session;
  }

  async resolve(id: string): Promise<Session | undefined> {
    const session = await this.store.get(id);
    if (!session) return undefined;
    if (session.expiresAt < this.now()) {
      this.store.delete(id);
      return undefined;
    }
    return session;
  }

  /** Push the expiry forward; called on every authenticated request. */
  async touch(session: Session): Promise<Session> {
    const next = { ...session, expiresAt: new Date(this.now().getTime() + this.ttlMs) };
    await this.store.put(next);
    return next;
  }

  async destroy(id: string): Promise<void> {
    await this.store.delete(id);
  }
}
`,
  "src/http/auth-middleware.ts": `import type { SessionManager } from "../session/manager";

export function requireSession(sessions: SessionManager) {
  return async (req: any, res: any, next: () => void) => {
    const id = req.cookies?.sid;
    const session = id ? await sessions.resolve(id) : undefined;
    if (!session) {
      res.clearCookie("sid");
      res.status(401).end();
      return;
    }
    req.session = await sessions.touch(session);
    next();
  };
}
`,
  "src/http/login.ts": `import type { SessionManager } from "../session/manager";

export async function login(sessions: SessionManager, userId: string, res: any) {
  const session = await sessions.create(userId);
  res.cookie("sid", session.id, { httpOnly: true, sameSite: "lax", expires: session.expiresAt });
  return session;
}
`,
  "test/session.test.ts": `import { SessionManager } from "../src/session/manager";
import { memoryStore } from "./helpers";

test("creates and resolves a session", async () => {
  const m = new SessionManager(memoryStore());
  const s = await m.create("u1");
  expect(await m.resolve(s.id)).toEqual(s);
});

test("expired sessions do not resolve", async () => {
  let now = new Date("2026-01-01T00:00:00Z");
  const m = new SessionManager(memoryStore(), 1000, () => now);
  const s = await m.create("u1");
  now = new Date("2026-01-01T00:00:02Z");
  expect(await m.resolve(s.id)).toBeUndefined();
});
`,
  "docs/sessions.md":
    "# Sessions\n\nSessions are stored server side and identified by the `sid` cookie.\nThey expire after seven days without activity; each authenticated request extends them.\n",
  "package-lock.json": '{\n  "name": "app",\n  "lockfileVersion": 3,\n  "packages": {}\n}\n',
});
git("add", "-A");
git("commit", "-q", "-m", "Expire sessions after a week of inactivity");

const { review: initial } = await initReview({ cwd: root, range: "main..session-expiry" });
let review: ReviewFile = {
  ...initial,
  subject: {
    ...initial.subject,
    repo: { owner: "acme", name: "app" },
    pr: { number: 482, url: "https://github.com/acme/app/pull/482", title: "Expire sessions after a week of inactivity", author: "dana" },
  },
};
const session: ReviewSession = {
  get: () => review,
  save: (next) => {
    review = next;
  },
  ai: () => ({ provider: "anthropic", model: "claude-sonnet-4-5" }),
};
const tool = (name: string, params: unknown) => {
  const t = ALL_TOOLS.find((x) => x.name === name)!;
  (t.run as (s: ReviewSession, p: unknown) => unknown)(session, params);
};
const model = parsePatch(review.patch);
const hunks = (path: string) => model.byPath.get(path)!.hunks.map((h) => h.id);
const manager = model.byPath.get("src/session/manager.ts")!.hunks;

tool("review_set_steps", {
  steps: [
    {
      id: "session-shape",
      title: "Sessions gain an expiry",
      kind: "context",
      narrative:
        "`Session` now carries `expiresAt`, and a seven-day `DEFAULT_TTL_MS` is introduced. Every later step reads or writes this field, so check that it is required rather than optional: existing stored sessions will not have it.",
      items: [{ path: "src/session/types.ts", hunks: "all" }],
    },
    {
      id: "manager",
      title: "The manager sets, checks and extends expiry",
      kind: "core",
      dependsOn: ["session-shape"],
      narrative:
        "`create` stamps `expiresAt`, `resolve` rejects and deletes expired sessions, and the new `touch` slides the expiry forward. The clock is injectable so tests can move time. This is where the behavior change lives: look at the expired branch in `resolve` closely.",
      items: [{ path: "src/session/manager.ts", hunks: "all" }],
    },
    {
      id: "http",
      title: "HTTP layer: cookie expiry and sliding sessions",
      kind: "wiring",
      dependsOn: ["manager"],
      narrative:
        "Login now sets the cookie's `expires` to match the session, and the middleware calls `touch` on every authenticated request and clears the cookie on a 401.",
      items: [
        { path: "src/http/login.ts", hunks: "all" },
        { path: "src/http/auth-middleware.ts", hunks: "all" },
      ],
    },
    {
      id: "tests-docs",
      title: "Tests and docs",
      kind: "tests",
      dependsOn: ["manager"],
      narrative: "One new test covers expiry with a fake clock. Nothing covers `touch` or the middleware yet.",
      items: [
        { path: "test/session.test.ts", hunks: "all" },
        { path: "docs/sessions.md", hunks: "all" },
      ],
    },
    {
      id: "lockfile",
      title: "Lockfile",
      kind: "mechanical",
      narrative: "An empty `packages` map added by npm. Safe to skim.",
      items: [{ path: "package-lock.json", hunks: hunks("package-lock.json") }],
    },
  ],
});
tool("review_overview", {
  summary:
    "Sessions now expire after seven days without activity. The change adds `expiresAt` to the session model, enforces it in `SessionManager.resolve`, slides it forward on each authenticated request, and mirrors it in the cookie.\n\nThe risk is in `resolve`: the expired-session delete is not awaited, and sessions stored before this change have no `expiresAt`.",
});
const expiredLine = manager.flatMap((h) => h.rows).find((r) => r.text.includes("this.store.delete(id);") && r.type === "add")!.newLine!;
tool("review_comment", {
  path: "src/session/manager.ts",
  start: expiredLine,
  severity: "major",
  category: "bug",
  body: "The delete is not awaited, so a store error becomes an unhandled rejection and the request still returns as if the session was cleaned up. Await it (or deliberately `void` it and catch).",
  suggestion: "      await this.store.delete(id);",
});
const compareLine = manager.flatMap((h) => h.rows).find((r) => r.text.includes("session.expiresAt < this.now()"))!.newLine!;
tool("review_comment", {
  path: "src/session/manager.ts",
  start: compareLine,
  severity: "blocker",
  category: "correctness",
  body: "Sessions written before this deploy have no `expiresAt`. `undefined < date` is `false`, so they never expire. Either backfill the store or treat a missing `expiresAt` as `createdAt + ttl`.",
});
const touchLine = model.byPath.get("src/http/auth-middleware.ts")!.hunks.flatMap((h) => h.rows).find((r) => r.text.includes("sessions.touch"))!.newLine!;
tool("review_comment", {
  path: "src/http/auth-middleware.ts",
  start: touchLine,
  severity: "minor",
  category: "performance",
  body: "`touch` writes to the store on every authenticated request. Consider only extending when less than half the TTL remains.",
});
tool("review_annotate", {
  path: "src/session/manager.ts",
  start: manager.flatMap((h) => h.rows).find((r) => r.text.includes("private now = () => new Date()"))!.newLine!,
  body: "Injecting the clock is what lets the new test move time forward without sleeping.",
});

const loginLine = model.byPath.get("src/http/login.ts")!.hunks[0]!.rows.find((r) => r.type === "add")!.newLine!;
review = mergeGitHubThreads(
  review,
  threadsFromGitHub(review, [
    {
      id: 9001,
      path: "src/http/login.ts",
      body: "Should this also set `secure: true`? We only serve over HTTPS.",
      user: { login: "priya" },
      created_at: "2026-11-14T16:02:00Z",
      html_url: "https://github.com/acme/app/pull/482#discussion_r9001",
      commit_id: review.subject.head.sha,
      original_commit_id: review.subject.head.sha,
      line: loginLine,
      start_line: null,
      side: "RIGHT",
      start_side: null,
      original_line: loginLine,
      original_start_line: null,
      diff_hunk: "",
    },
    {
      id: 9002,
      in_reply_to_id: 9001,
      path: "src/http/login.ts",
      body: "Good call, I'll add it in a follow-up so this PR stays about expiry.",
      user: { login: "dana" },
      created_at: "2026-11-14T17:40:00Z",
      html_url: "https://github.com/acme/app/pull/482#discussion_r9002",
      commit_id: review.subject.head.sha,
      original_commit_id: review.subject.head.sha,
      line: loginLine,
      start_line: null,
      side: "RIGHT",
      start_side: null,
      original_line: loginLine,
      original_start_line: null,
      diff_hunk: "",
    },
  ]),
);
const testsModel = model.byPath.get("test/session.test.ts")!;
review = {
  ...review,
  threads: [
    ...review.threads,
    {
      id: "local_example",
      source: "local",
      status: "open",
      anchor: makeLinesAnchor(model, {
        path: "test/session.test.ts",
        side: "new",
        start: testsModel.hunks[0]!.rows.find((r) => r.text.startsWith('test("expired'))!.newLine!,
        commit: review.subject.head.sha,
      }),
      comments: [
        {
          id: "c_local_example",
          author: { name: "Matt", kind: "human" },
          body: "Can we add a test for `touch` sliding the expiry, and one for the middleware clearing the cookie?",
          createdAt: "2026-11-15T09:12:00Z",
        },
      ],
    },
  ],
};

const out = join(dirname(fileURLToPath(import.meta.url)), "session-expiry.review.json");
writeReview(out, review);
rmSync(root, { recursive: true, force: true });
console.log(out);
