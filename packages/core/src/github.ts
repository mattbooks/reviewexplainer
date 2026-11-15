/**
 * GitHub: fetch PR metadata and review comments, map them into threads, and
 * push local threads as a pending review.
 */
import {
  fingerprintLines,
  makeLinesAnchor,
  parsePatch,
  relocateRange,
  knownLines,
  upsertThread,
  type Anchor,
  type PatchModel,
  type ReviewFile,
  type Side,
  type Thread,
} from "@reviewexplainer/format";
import { run } from "./git.ts";

export interface GitHubRepo {
  owner: string;
  name: string;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  author: string;
  body?: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
}

export interface PullRequestDetails extends PullRequestInfo {
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  isFork: boolean;
  cloneUrl: string;
  updatedAt: string;
}

export interface SearchHit {
  owner: string;
  repo: string;
  number: number;
  updatedAt: string;
  title: string;
}

/** The subset of the REST review comment we use. */
export interface GitHubReviewComment {
  id: number;
  in_reply_to_id?: number;
  path: string;
  body: string;
  user: { login: string } | null;
  created_at: string;
  html_url: string;
  commit_id: string;
  original_commit_id: string;
  line: number | null;
  start_line: number | null;
  side: "LEFT" | "RIGHT" | null;
  start_side: "LEFT" | "RIGHT" | null;
  original_line: number | null;
  original_start_line: number | null;
  diff_hunk: string;
  subject_type?: "line" | "file";
  pull_request_review_id?: number | null;
}

export interface GitHubReview {
  id: number;
  body: string | null;
  user: { login: string } | null;
  state: string;
  submitted_at?: string;
  html_url: string;
}

export type Fetch = typeof fetch;

export async function resolveToken(): Promise<string | undefined> {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    return (await run("gh", ["auth", "token"], process.cwd())).trim() || undefined;
  } catch {
    return undefined;
  }
}

export class GitHubClient {
  constructor(
    private token: string | undefined,
    private fetchImpl: Fetch = fetch,
    private apiBase = process.env.GITHUB_API_URL || "https://api.github.com",
  ) {}

  static async create(fetchImpl?: Fetch): Promise<GitHubClient> {
    return new GitHubClient(await resolveToken(), fetchImpl);
  }

  async request<T>(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<T> {
    const headers: Record<string, string> = {
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "greview",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      const hint = res.status === 401 || res.status === 404 ? " (check GITHUB_TOKEN or `gh auth login`)" : "";
      throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}${hint}`);
    }
    if (accept.includes("diff")) return (await res.text()) as T;
    return (await res.json()) as T;
  }

  async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page < 100; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.request<T[]>("GET", `${path}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  async pullRequest(repo: GitHubRepo, number: number): Promise<PullRequestInfo> {
    const pr = await this.request<any>("GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`);
    return {
      number,
      title: pr.title,
      url: pr.html_url,
      author: pr.user?.login ?? "unknown",
      body: pr.body ?? undefined,
      baseRef: pr.base.ref,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
    };
  }

  /** Open or closed state, fork status and clone URL: what `greview watch` needs to decide what to do. */
  async pullRequestDetails(repo: GitHubRepo, number: number): Promise<PullRequestDetails> {
    const pr = await this.request<any>("GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`);
    const baseRepo = pr.base?.repo?.full_name as string | undefined;
    const headRepo = pr.head?.repo?.full_name as string | undefined;
    return {
      number,
      title: pr.title,
      url: pr.html_url,
      author: pr.user?.login ?? "unknown",
      baseRef: pr.base.ref,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      state: pr.state === "open" ? "open" : "closed",
      merged: Boolean(pr.merged_at),
      draft: Boolean(pr.draft),
      // A deleted fork has no head repo; treat it as a fork too.
      isFork: !headRepo || headRepo.toLowerCase() !== (baseRepo ?? "").toLowerCase(),
      cloneUrl: pr.base?.repo?.clone_url ?? `https://github.com/${repo.owner}/${repo.name}.git`,
      updatedAt: pr.updated_at,
    };
  }

  /** Pull requests matching a GitHub search query (`is:pr` is added). Up to `limit` results. */
  async searchPullRequests(query: string, limit = 300): Promise<SearchHit[]> {
    const q = /\bis:pr\b|\btype:pr\b/.test(query) ? query : `${query} is:pr`;
    const out: SearchHit[] = [];
    for (let page = 1; out.length < limit && page <= 10; page++) {
      const res = await this.request<{ items: any[] }>(
        "GET",
        `/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=100&page=${page}`,
      );
      for (const item of res.items) {
        const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(item.repository_url ?? "");
        if (!m || !item.pull_request) continue;
        out.push({ owner: m[1]!, repo: m[2]!, number: item.number, updatedAt: item.updated_at, title: item.title });
      }
      if (res.items.length < 100) break;
    }
    return out.slice(0, limit);
  }

  pullRequestDiff(repo: GitHubRepo, number: number): Promise<string> {
    return this.request<string>("GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`, undefined, "application/vnd.github.v3.diff");
  }

  reviewComments(repo: GitHubRepo, number: number): Promise<GitHubReviewComment[]> {
    return this.paginate<GitHubReviewComment>(`/repos/${repo.owner}/${repo.name}/pulls/${number}/comments`);
  }

  reviews(repo: GitHubRepo, number: number): Promise<GitHubReview[]> {
    return this.paginate<GitHubReview>(`/repos/${repo.owner}/${repo.name}/pulls/${number}/reviews`);
  }
}

const sideOf = (s: "LEFT" | "RIGHT" | null | undefined): Side => (s === "LEFT" ? "old" : "new");

/** Lines of one side taken from the end of a GitHub diff_hunk. */
export function diffHunkTail(diffHunk: string, side: Side, count: number): string[] {
  const lines = diffHunk.split("\n").slice(1);
  const sideLines = lines
    .filter((l) => (side === "old" ? l[0] !== "+" : l[0] !== "-") && l[0] !== "\\")
    .map((l) => l.slice(1));
  return sideLines.slice(-count);
}

function anchorForComment(c: GitHubReviewComment, model: PatchModel, review: ReviewFile): { anchor: Anchor; outdated: boolean } {
  if (c.subject_type === "file" || (c.line === null && c.original_line === null)) {
    return { anchor: { kind: "file", path: c.path }, outdated: !model.byPath.has(c.path) };
  }
  const side = sideOf(c.side);
  if (c.line !== null) {
    const start = c.start_line ?? c.line;
    try {
      return { anchor: makeLinesAnchor(model, { path: c.path, side, start, end: c.line, commit: c.commit_id }, review), outdated: false };
    } catch {
      // Fall through to relocation by content.
    }
  }
  const end = c.original_line ?? c.line ?? 1;
  const start = c.original_start_line ?? c.start_line ?? end;
  const length = end - start + 1;
  const text = diffHunkTail(c.diff_hunk, side, length);
  const fingerprint = fingerprintLines(text);
  const file = model.byPath.get(c.path);
  if (file && text.length === length) {
    const known = knownLines(file, side);
    const max = Math.max(0, ...known.keys());
    const at = relocateRange(fingerprint, length, start, (n) => known.get(n), max);
    if (at !== undefined) {
      return {
        anchor: makeLinesAnchor(model, { path: c.path, side, start: at, end: at + length - 1, commit: review.subject.head.sha }, review),
        outdated: false,
      };
    }
  }
  return {
    anchor: { kind: "lines", path: c.path, side, start, end, commit: c.original_commit_id, fingerprint },
    outdated: true,
  };
}

/** Group review comments into threads (root + replies) anchored to the review's patch. */
export function threadsFromGitHub(
  review: ReviewFile,
  comments: GitHubReviewComment[],
  reviews: GitHubReview[] = [],
): Thread[] {
  const model = parsePatch(review.patch);
  const roots = comments.filter((c) => !c.in_reply_to_id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const replies = new Map<number, GitHubReviewComment[]>();
  for (const c of comments) {
    if (c.in_reply_to_id) replies.set(c.in_reply_to_id, [...(replies.get(c.in_reply_to_id) ?? []), c]);
  }
  const threads: Thread[] = [];
  for (const root of roots) {
    const all = [root, ...(replies.get(root.id) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at))];
    const { anchor, outdated } = anchorForComment(root, model, review);
    threads.push({
      id: `gh_${root.id}`,
      anchor,
      source: "github",
      status: outdated ? "outdated" : "open",
      external: { github: { commentIds: all.map((c) => c.id), url: root.html_url } },
      comments: all.map((c) => ({
        id: `ghc_${c.id}`,
        author: { name: c.user?.login ?? "ghost", kind: "human" as const },
        body: c.body,
        createdAt: c.created_at,
        githubId: c.id,
      })),
    });
  }
  for (const r of reviews) {
    if (!r.body?.trim() || r.state === "PENDING") continue;
    threads.push({
      id: `ghr_${r.id}`,
      anchor: { kind: "review" },
      source: "github",
      status: "open",
      external: { github: { commentIds: [], url: r.html_url } },
      comments: [
        {
          id: `ghrc_${r.id}`,
          author: { name: r.user?.login ?? "ghost", kind: "human" },
          body: `**${r.state.toLowerCase().replace(/_/g, " ")}**\n\n${r.body}`,
          createdAt: r.submitted_at ?? new Date().toISOString(),
          githubId: r.id,
        },
      ],
    });
  }
  return threads;
}

/** Upsert GitHub threads, keeping a locally set resolved status. */
export function mergeGitHubThreads(review: ReviewFile, incoming: Thread[]): ReviewFile {
  let threads = review.threads;
  for (const t of incoming) {
    const existing = threads.find((x) => x.id === t.id);
    const status = existing?.status === "resolved" && t.status === "open" ? "resolved" : t.status;
    threads = upsertThread(threads, { ...t, status });
  }
  return { ...review, threads };
}

export interface PendingReviewPayload {
  commit_id: string;
  body: string;
  comments: {
    path: string;
    body: string;
    line: number;
    side: "LEFT" | "RIGHT";
    start_line?: number;
    start_side?: "LEFT" | "RIGHT";
  }[];
  /** Local thread ids in the same order as `comments`. */
  threadIds: string[];
}

function threadBody(t: Thread): string {
  const head = [t.severity && `**${t.severity}**`, t.category && `_${t.category}_`].filter(Boolean).join(" · ");
  const parts = t.comments.map((c, i) => (i === 0 ? c.body : `> ${c.author.name}: ${c.body}`));
  const suggestion = t.suggestion ? `\n\n\`\`\`suggestion\n${t.suggestion.replacement}\n\`\`\`` : "";
  return `${head ? `${head}\n\n` : ""}${parts.join("\n\n")}${suggestion}`;
}

/**
 * Build the body of a pending GitHub review from open local threads that have
 * not been pushed yet. Line and hunk threads become line comments; file and
 * review threads go into the review body.
 */
export function buildPendingReview(review: ReviewFile): PendingReviewPayload {
  const model = parsePatch(review.patch);
  const payload: PendingReviewPayload = { commit_id: review.subject.head.sha, body: "", comments: [], threadIds: [] };
  const bodyParts: string[] = [];
  const bodyThreadIds: string[] = [];
  for (const t of review.threads) {
    if (t.source !== "local" || t.status !== "open" || t.external?.github) continue;
    const a = t.anchor;
    if (a.kind === "lines") {
      const comment: PendingReviewPayload["comments"][number] = {
        path: a.path,
        body: threadBody(t),
        line: a.end,
        side: a.side === "old" ? "LEFT" : "RIGHT",
      };
      if (a.start !== a.end) {
        comment.start_line = a.start;
        comment.start_side = comment.side;
      }
      payload.comments.push(comment);
      payload.threadIds.push(t.id);
    } else if (a.kind === "hunk") {
      const h = model.hunkById.get(a.hunk)?.hunk;
      const last = h ? [...h.rows].reverse().find((r) => r.newLine !== undefined || r.oldLine !== undefined) : undefined;
      if (h && last) {
        const onNew = last.newLine !== undefined;
        payload.comments.push({
          path: a.path,
          body: threadBody(t),
          line: (onNew ? last.newLine : last.oldLine)!,
          side: onNew ? "RIGHT" : "LEFT",
        });
        payload.threadIds.push(t.id);
      }
    } else {
      bodyParts.push(`${a.kind === "file" ? `**${a.path}**: ` : ""}${threadBody(t)}`);
      bodyThreadIds.push(t.id);
    }
  }
  payload.body = bodyParts.join("\n\n---\n\n");
  payload.threadIds.push(...bodyThreadIds);
  return payload;
}

/** Create a pending review on GitHub and record the new comment ids on the threads. */
export async function pushPendingReview(
  client: GitHubClient,
  repo: GitHubRepo,
  review: ReviewFile,
): Promise<{ review: ReviewFile; pushed: number; url: string }> {
  const pr = review.subject.pr;
  if (!pr) throw new Error("This review has no pull request; create it with `greview init --pr <number>`");
  const payload = buildPendingReview(review);
  if (payload.threadIds.length === 0) return { review, pushed: 0, url: `${pr.url}/files` };
  const { threadIds, ...body } = payload;
  const created = await client.request<{ id: number; html_url: string }>(
    "POST",
    `/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/reviews`,
    body,
  );
  const posted = await client.paginate<GitHubReviewComment>(
    `/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/reviews/${created.id}/comments`,
  );
  const lineThreadIds = threadIds.slice(0, payload.comments.length);
  const unclaimed = [...posted];
  const claim = (sent: PendingReviewPayload["comments"][number]) => {
    const i = unclaimed.findIndex(
      (c) => c.path === sent.path && (c.line ?? c.original_line) === sent.line && c.body.trim() === sent.body.trim(),
    );
    return i === -1 ? undefined : unclaimed.splice(i, 1)[0];
  };
  const threads = review.threads.map((t) => {
    const i = lineThreadIds.indexOf(t.id);
    if (i !== -1) {
      const c = claim(payload.comments[i]!);
      return { ...t, external: { github: { commentIds: c ? [c.id] : [], url: c?.html_url ?? created.html_url } } };
    }
    if (threadIds.includes(t.id)) {
      return { ...t, external: { github: { commentIds: [], url: created.html_url } } };
    }
    return t;
  });
  return { review: { ...review, threads }, pushed: threadIds.length, url: `${pr.url}/files` };
}

export async function openInBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    await run(cmd, args, process.cwd());
  } catch {
    // No browser available (e.g. over SSH): the caller prints the URL.
  }
}
