/**
 * High-level flows used by the CLI and the pi extension: create a review from
 * git (or a GitHub PR), sync GitHub comments, and refresh after new pushes.
 */
import { createReview, recordGenerator, type ReviewFile, type Subject } from "@reviewexplainer/format";
import { attributeFlags, collectDiff, git, githubRepo, repoRoot, revParse, showFile } from "./git.ts";
import { GitHubClient, mergeGitHubThreads, threadsFromGitHub, type GitHubRepo } from "./github.ts";
import { heuristicGuide } from "./heuristic.ts";
import { refreshReview, type RefreshReport } from "./refresh.ts";
import { roleForPath } from "./roles.ts";

export const TOOL_NAME = "greview";
export const TOOL_VERSION = "0.1.0";
const MAX_BLOB_BYTES = 1_000_000;

export async function defaultBase(cwd: string): Promise<string> {
  try {
    const ref = (await git(cwd, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")).trim();
    return ref.replace(/^refs\/remotes\//, "");
  } catch {
    for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
      try {
        await revParse(cwd, candidate);
        return candidate;
      } catch {
        // try the next one
      }
    }
  }
  throw new Error("Could not find a default base branch; pass one explicitly, e.g. `greview init main..HEAD`");
}

async function ensureCommit(cwd: string, sha: string, fetchSpec: string): Promise<void> {
  try {
    await revParse(cwd, sha);
  } catch {
    await git(cwd, "fetch", "--quiet", "origin", fetchSpec);
    await revParse(cwd, sha);
  }
}

async function roles(cwd: string, paths: string[]): Promise<Record<string, ReviewFile["files"][number]["role"]>> {
  const attrs = await attributeFlags(cwd, paths);
  return Object.fromEntries(paths.map((p) => [p, roleForPath(p, attrs.get(p))]));
}

async function collectBlobs(cwd: string, review: ReviewFile): Promise<NonNullable<ReviewFile["blobs"]>> {
  const blobs: NonNullable<ReviewFile["blobs"]> = {};
  const baseSha = review.subject.mergeBase ?? review.subject.base.sha;
  for (const f of review.files) {
    if (f.binary) continue;
    const entry: { old?: string; new?: string } = {};
    if (f.status !== "added") {
      const old = await showFile(cwd, baseSha, f.oldPath ?? f.path);
      if (old !== undefined && old.length <= MAX_BLOB_BYTES) entry.old = old;
    }
    if (f.status !== "deleted") {
      const next = await showFile(cwd, review.subject.head.sha, f.path);
      if (next !== undefined && next.length <= MAX_BLOB_BYTES) entry.new = next;
    }
    if (entry.old !== undefined || entry.new !== undefined) blobs[f.path] = entry;
  }
  return blobs;
}

export interface InitOptions {
  cwd: string;
  /** "base..head", "base...head" or just "base". */
  range?: string;
  pr?: number;
  withBlobs?: boolean;
  client?: GitHubClient;
}

export interface InitResult {
  review: ReviewFile;
  root: string;
  repo?: GitHubRepo;
}

export function parseRange(range: string | undefined): { base?: string; head?: string } {
  if (!range) return {};
  const m = /^(.*?)\.\.\.?(.*)$/.exec(range);
  if (!m) return { base: range };
  return { base: m[1] || undefined, head: m[2] || undefined };
}

export async function initReview(opts: InitOptions): Promise<InitResult> {
  const root = await repoRoot(opts.cwd);
  const repo = await githubRepo(root);
  let subject: Subject;
  let patch: string;

  if (opts.pr !== undefined) {
    if (!repo) throw new Error("--pr needs a GitHub remote named origin");
    const client = opts.client ?? (await GitHubClient.create());
    const pr = await client.pullRequest(repo, opts.pr);
    let diff: Awaited<ReturnType<typeof collectDiff>> | undefined;
    try {
      await ensureCommit(root, pr.headSha, `pull/${pr.number}/head`);
      await ensureCommit(root, pr.baseSha, pr.baseRef);
      diff = await collectDiff(root, pr.baseSha, pr.headSha);
    } catch {
      diff = undefined;
    }
    patch = diff?.patch ?? (await client.pullRequestDiff(repo, pr.number));
    subject = {
      repo,
      base: { ref: pr.baseRef, sha: pr.baseSha },
      head: { ref: pr.headRef, sha: pr.headSha },
      pr: { number: pr.number, url: pr.url, title: pr.title, author: pr.author, ...(pr.body ? { body: pr.body } : {}) },
    };
    if (diff) subject.mergeBase = diff.mergeBase;
  } else {
    const parsed = parseRange(opts.range);
    const base = parsed.base ?? (await defaultBase(root));
    const head = parsed.head ?? "HEAD";
    const diff = await collectDiff(root, base, head);
    patch = diff.patch;
    subject = {
      base: { ref: base, sha: diff.baseSha },
      head: { ref: head, sha: diff.headSha },
      mergeBase: diff.mergeBase,
    };
    if (repo) subject.repo = repo;
  }

  const draft = createReview({ subject, patch, tool: TOOL_NAME, version: TOOL_VERSION });
  const fileRoles = await roles(root, draft.files.map((f) => f.path));
  let review: ReviewFile = { ...draft, files: draft.files.map((f) => ({ ...f, role: fileRoles[f.path] })) };
  review = await heuristicGuide(review, {
    contentAt: (path) => showFile(root, subject.head.sha, path),
  });
  if (opts.withBlobs) review = { ...review, blobs: await collectBlobs(root, review) };
  const result: InitResult = { review, root };
  if (repo) result.repo = repo;
  return result;
}

export async function syncGitHub(review: ReviewFile, client: GitHubClient): Promise<{ review: ReviewFile; added: number; total: number }> {
  const pr = review.subject.pr;
  const repo = review.subject.repo;
  if (!pr || !repo) throw new Error("This review has no pull request; create it with `greview init --pr <number>`");
  const [comments, reviews] = await Promise.all([client.reviewComments(repo, pr.number), client.reviews(repo, pr.number)]);
  const incoming = threadsFromGitHub(review, comments, reviews);
  const before = new Set(review.threads.map((t) => t.id));
  const next = mergeGitHubThreads(review, incoming);
  return {
    review: recordGenerator(next, `${TOOL_NAME} sync github`, TOOL_VERSION),
    added: incoming.filter((t) => !before.has(t.id)).length,
    total: incoming.length,
  };
}

/** Re-diff against the latest head (PR head, or the original head ref) and re-anchor. */
export async function refreshFromGit(
  review: ReviewFile,
  opts: { cwd: string; client?: GitHubClient; head?: string },
): Promise<{ review: ReviewFile; report: RefreshReport }> {
  const root = await repoRoot(opts.cwd);
  let subject: Subject;
  let patch: string;
  const pr = review.subject.pr;
  if (pr && review.subject.repo && !opts.head) {
    const client = opts.client ?? (await GitHubClient.create());
    const info = await client.pullRequest(review.subject.repo, pr.number);
    await ensureCommit(root, info.headSha, `pull/${pr.number}/head`);
    await ensureCommit(root, info.baseSha, info.baseRef);
    const diff = await collectDiff(root, info.baseSha, info.headSha);
    patch = diff.patch;
    subject = {
      ...review.subject,
      base: { ref: info.baseRef, sha: info.baseSha },
      head: { ref: info.headRef, sha: info.headSha },
      mergeBase: diff.mergeBase,
      pr: { ...pr, title: info.title },
    };
  } else {
    const base = review.subject.base.ref ?? review.subject.base.sha;
    const head = opts.head ?? review.subject.head.ref ?? "HEAD";
    const diff = await collectDiff(root, base, head);
    patch = diff.patch;
    subject = { ...review.subject, base: { ...review.subject.base, sha: diff.baseSha }, head: { ...review.subject.head, sha: diff.headSha }, mergeBase: diff.mergeBase };
  }
  const draft = createReview({ subject, patch, tool: TOOL_NAME, version: TOOL_VERSION });
  const fileRoles = await roles(root, draft.files.map((f) => f.path));
  const headSha = subject.head.sha;
  const baseSha = subject.mergeBase ?? subject.base.sha;
  const { review: next, report } = await refreshReview(review, {
    patch,
    subject,
    roles: fileRoles,
    fileLines: async (path, side) => {
      const text = await showFile(root, side === "new" ? headSha : baseSha, path);
      return text?.split("\n");
    },
  });
  let out = recordGenerator(next, `${TOOL_NAME} refresh`, TOOL_VERSION);
  if (review.blobs) out = { ...out, blobs: await collectBlobs(root, out) };
  return { review: out, report };
}
