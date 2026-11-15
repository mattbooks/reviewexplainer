/**
 * `greview watch`: keep a review (and an AI pass) for every open PR matching
 * your GitHub search filters, each in its own worktree.
 *
 * Every tick compares what the filters return with the tracked records:
 * new PRs get a worktree, a review file and an AI review; activity syncs
 * GitHub comments; a new head (after it settles) refreshes the review and
 * resumes the same AI session with a re-review prompt; closed PRs lose their
 * worktree at once and their review after `retainDays`.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  GitHubClient,
  initReview,
  mergeGitHubThreads,
  readReview,
  refreshFromGit,
  reviewPath,
  threadsFromGitHub,
  writeReview,
  type PullRequestDetails,
  type SearchHit,
} from "@reviewexplainer/core";
import { rereviewPrompt, runAi, type AiOptions } from "@reviewexplainer/pi-extension";
import type { WatchConfig, WatchFilter } from "./config.ts";
import { prKey, StateStore, type PrRecord } from "./state.ts";
import { Worktrees, type RemoteUrl } from "./worktrees.ts";

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface WatcherOptions {
  config: WatchConfig;
  client: GitHubClient;
  log?: (line: string) => void;
  now?: () => Date;
  /** Map a clone URL to what git should fetch (tests point it at a local repo). */
  remoteUrl?: RemoteUrl;
  /** Extra options for every AI run (tests inject a scripted model). */
  ai?: Partial<AiOptions>;
  /** Replace the AI runner (tests). */
  runAi?: typeof runAi;
}

export interface TickSummary {
  matched: number;
  started: string[];
  synced: string[];
  refreshed: string[];
  closed: string[];
  paused: string[];
  purged: string[];
  skipped: string[];
  queued: string[];
}

export class Watcher {
  readonly state: StateStore;
  readonly worktrees: Worktrees;
  private readonly running = new Map<string, Promise<void>>();
  private readonly log: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly opts: WatcherOptions) {
    this.state = new StateStore(opts.config.root);
    this.worktrees = new Worktrees(opts.config.root, opts.remoteUrl);
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.now = opts.now ?? (() => new Date());
  }

  private get config(): WatchConfig {
    return this.opts.config;
  }

  private get client(): GitHubClient {
    return this.opts.client;
  }

  private put(rec: PrRecord): PrRecord {
    return this.state.put(rec);
  }

  /** Bring disk and records back in line after a crash or restart. */
  async recover(): Promise<string[]> {
    const notes: string[] = [];
    for (const rec of this.state.all()) {
      if (rec.status === "reviewing") {
        this.put({ ...rec, status: "queued" });
        notes.push(`${rec.key}: AI run was interrupted; queued again`);
      } else if (rec.status === "preparing") {
        await this.worktrees.remove(rec.owner, rec.repo, rec.number);
        this.state.remove(rec.key);
        notes.push(`${rec.key}: setup was interrupted; it will be set up again`);
      }
    }
    const keep = new Set(this.state.all().flatMap((r) => (r.worktree && r.status !== "closed" ? [r.worktree] : [])));
    for (const path of await this.worktrees.pruneOrphans(keep)) notes.push(`removed orphaned worktree ${path}`);
    for (const n of notes) this.log(n);
    return notes;
  }

  /** One pass over the filters and the tracked pull requests. AI runs start in the background. */
  async tick(): Promise<TickSummary> {
    const summary: TickSummary = { matched: 0, started: [], synced: [], refreshed: [], closed: [], paused: [], purged: [], skipped: [], queued: [] };
    const now = this.now();

    // 1. What the filters match now.
    const matches = new Map<string, { hit: SearchHit; filters: WatchFilter[] }>();
    for (const filter of this.config.filters) {
      for (const hit of await this.client.searchPullRequests(filter.query)) {
        const key = prKey(hit.owner, hit.repo, hit.number);
        const entry = matches.get(key) ?? { hit, filters: [] };
        entry.filters.push(filter);
        matches.set(key, entry);
      }
    }
    summary.matched = matches.size;

    // 2. New and changed pull requests.
    for (const [key, { hit, filters }] of matches) {
      let rec = this.state.get(key);
      if (rec?.status === "skipped") continue;
      if (rec?.status === "closed") {
        // Reopened: start over.
        await this.purge(rec);
        rec = undefined;
      }
      if (rec?.status === "preparing") continue;
      const ai = filters.some((f) => f.ai);
      const findings = filters.some((f) => f.findings);
      if (!rec) {
        const details = await this.client.pullRequestDetails({ owner: hit.owner, name: hit.repo }, hit.number);
        if (details.isFork) {
          this.put(this.newRecord(key, hit, details, filters, ai, findings, { status: "skipped", skipReason: "from a fork" }));
          this.log(`${key}: skipped (from a fork)`);
          summary.skipped.push(key);
          continue;
        }
        await this.start(key, hit, details, filters, ai, findings);
        summary.started.push(key);
        continue;
      }
      rec = { ...rec, filters: filters.map((f) => f.name), ai, findings };
      if (rec.status === "paused") {
        rec.status = rec.failedStep ? "failed" : rec.ai && rec.reviewedHead !== rec.headSha ? "queued" : "ready";
        delete rec.pausedAt;
        this.log(`${key}: matches a filter again; resumed`);
      }
      if (rec.updatedAt !== hit.updatedAt) {
        const details = await this.client.pullRequestDetails({ owner: rec.owner, name: rec.repo }, rec.number);
        rec.title = details.title;
        rec.updatedAt = hit.updatedAt;
        await this.syncComments(rec);
        summary.synced.push(key);
        if (details.headSha !== rec.headSha && details.headSha !== rec.pendingHead) {
          rec.pendingHead = details.headSha;
          rec.pendingSince = now.toISOString();
          this.log(`${key}: new commits (${details.headSha.slice(0, 12)}); re-review after ${this.config.settleSeconds}s without further pushes`);
        }
      }
      this.put(rec);
    }

    // 3. Tracked pull requests the filters no longer return.
    for (const rec of this.state.all()) {
      if (matches.has(rec.key) || rec.status === "skipped") continue;
      if (rec.status === "closed") {
        if (now.getTime() - Date.parse(rec.closedAt!) > this.config.retainDays * DAY_MS) {
          await this.purge(rec);
          summary.purged.push(rec.key);
        }
        continue;
      }
      if (this.running.has(rec.key)) continue;
      let details: PullRequestDetails | undefined;
      try {
        details = await this.client.pullRequestDetails({ owner: rec.owner, name: rec.repo }, rec.number);
      } catch (e) {
        if (!/\b404\b/.test((e as Error).message)) throw e;
      }
      if (!details || details.state === "closed") {
        await this.close(rec, details?.merged ?? false);
        summary.closed.push(rec.key);
      } else if (rec.status !== "paused") {
        this.put({ ...rec, status: "paused", pausedAt: now.toISOString() });
        this.log(`${rec.key}: no longer matches a filter; paused (worktree kept)`);
        summary.paused.push(rec.key);
      } else if (now.getTime() - Date.parse(rec.pausedAt!) > this.config.retainDays * DAY_MS) {
        await this.close(rec, false);
        await this.purge(this.state.get(rec.key)!);
        summary.purged.push(rec.key);
      }
    }

    // 4. Settled pushes: refresh the review, then queue a re-review.
    for (const rec of this.state.all()) {
      if (!rec.pendingHead || this.running.has(rec.key) || !["ready", "queued", "failed"].includes(rec.status)) continue;
      if (now.getTime() - Date.parse(rec.pendingSince!) < this.config.settleSeconds * 1000) continue;
      await this.applyPush(rec);
      summary.refreshed.push(rec.key);
    }

    // 5. Retries.
    for (const rec of this.state.all()) {
      if (rec.status !== "failed" || rec.attempts >= MAX_ATTEMPTS) continue;
      if (rec.lastAttemptAt && now.getTime() - Date.parse(rec.lastAttemptAt) < RETRY_AFTER_MS) continue;
      if (rec.failedStep === "prepare") {
        await this.worktrees.remove(rec.owner, rec.repo, rec.number);
        this.state.remove(rec.key); // set up from scratch on the next tick
      } else {
        this.put({ ...rec, status: "queued" });
      }
    }

    // 6. Start AI runs up to the concurrency limit.
    for (const rec of this.state.all()) {
      if (rec.status !== "queued" || this.running.has(rec.key)) continue;
      if (this.running.size >= this.config.concurrency) break;
      const job = this.review(rec.key).finally(() => this.running.delete(rec.key));
      this.running.set(rec.key, job);
      summary.queued.push(rec.key);
    }
    return summary;
  }

  /** Wait for AI runs in progress (used by `--once` and tests). */
  async drain(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()]);
  }

  get busy(): string[] {
    return [...this.running.keys()];
  }

  /** Poll until the signal aborts. */
  async run(signal: AbortSignal): Promise<void> {
    await this.recover();
    while (!signal.aborted) {
      try {
        const s = await this.tick();
        if (s.started.length + s.refreshed.length + s.closed.length + s.queued.length > 0) {
          this.log(
            `tick: ${s.matched} matching, ${s.started.length} new, ${s.refreshed.length} updated, ${s.closed.length} closed, ${this.running.size} AI running`,
          );
        }
      } catch (e) {
        this.log(`poll failed: ${(e as Error).message}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.config.intervalSeconds * 1000);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
    }
  }

  private newRecord(
    key: string,
    hit: SearchHit,
    details: PullRequestDetails,
    filters: WatchFilter[],
    ai: boolean,
    findings: boolean,
    extra: Partial<PrRecord> = {},
  ): PrRecord {
    const at = this.now().toISOString();
    return {
      key,
      owner: hit.owner,
      repo: hit.repo,
      number: hit.number,
      title: details.title,
      url: details.url,
      filters: filters.map((f) => f.name),
      ai,
      findings,
      status: "preparing",
      attempts: 0,
      createdAt: at,
      changedAt: at,
      ...extra,
    };
  }

  private async start(
    key: string,
    hit: SearchHit,
    details: PullRequestDetails,
    filters: WatchFilter[],
    ai: boolean,
    findings: boolean,
  ): Promise<void> {
    let rec = this.put(this.newRecord(key, hit, details, filters, ai, findings));
    this.log(`${key}: new — ${details.title}`);
    try {
      await this.worktrees.ensureMirror(rec.owner, rec.repo, details.cloneUrl);
      await this.worktrees.fetchPr(rec.owner, rec.repo, rec.number, details.baseRef);
      const worktree = await this.worktrees.checkout(rec.owner, rec.repo, rec.number, details.headSha);
      const { review } = await initReview({
        cwd: worktree,
        pr: rec.number,
        client: this.client,
        repo: { owner: rec.owner, name: rec.repo },
      });
      const reviewFile = reviewPath({ storage: "cache" }, { owner: rec.owner, repo: rec.repo, pr: rec.number, head: review.subject.head.sha });
      writeReview(reviewFile, review);
      rec = { ...rec, worktree, reviewFile, headSha: review.subject.head.sha, updatedAt: hit.updatedAt };
      if (review.subject.head.sha !== details.headSha) await this.worktrees.checkout(rec.owner, rec.repo, rec.number, review.subject.head.sha);
      await this.syncComments(rec);
      rec = this.put({ ...rec, status: ai ? "queued" : "ready", job: "review" });
      this.log(`${key}: review file ready (${review.files.length} files)${ai ? "; AI review queued" : ""}`);
    } catch (e) {
      this.put({ ...rec, status: "failed", failedStep: "prepare", attempts: rec.attempts + 1, lastAttemptAt: this.now().toISOString(), lastError: (e as Error).message });
      this.log(`${key}: setup failed: ${(e as Error).message}`);
    }
  }

  /** Pull GitHub threads in. Network first, then a quick read-merge-write so concurrent edits survive. */
  private async syncComments(rec: PrRecord): Promise<void> {
    if (!rec.reviewFile || !existsSync(rec.reviewFile)) return;
    const repo = { owner: rec.owner, name: rec.repo };
    const [comments, reviews] = await Promise.all([this.client.reviewComments(repo, rec.number), this.client.reviews(repo, rec.number)]);
    const latest = readReview(rec.reviewFile);
    writeReview(rec.reviewFile, mergeGitHubThreads(latest, threadsFromGitHub(latest, comments, reviews)));
  }

  private async applyPush(rec: PrRecord): Promise<void> {
    const details = await this.client.pullRequestDetails({ owner: rec.owner, name: rec.repo }, rec.number);
    try {
      await this.worktrees.fetchPr(rec.owner, rec.repo, rec.number, details.baseRef);
      const review = readReview(rec.reviewFile!);
      const { review: next, report } = await refreshFromGit(review, { cwd: rec.worktree!, client: this.client });
      await this.worktrees.checkout(rec.owner, rec.repo, rec.number, next.subject.head.sha);
      writeReview(rec.reviewFile!, next);
      const head = next.subject.head.sha;
      const fresh = this.state.get(rec.key)!;
      const updated: PrRecord = {
        ...fresh,
        headSha: head,
        refresh: { newHunks: report.newHunks.length, relocated: report.relocated.length, outdated: report.outdated.length },
      };
      delete updated.pendingHead;
      delete updated.pendingSince;
      delete updated.failedStep;
      if (rec.ai) {
        updated.status = "queued";
        updated.attempts = 0;
        if (rec.reviewedHead) {
          updated.job = "rereview";
          updated.previousHead = rec.reviewedHead;
        } else {
          updated.job = "review";
        }
      }
      this.put(updated);
      this.log(
        `${rec.key}: refreshed to ${head.slice(0, 12)}: ${report.newHunks.length} new hunks, ${report.relocated.length} threads moved, ${report.outdated.length} outdated${rec.ai ? "; AI re-review queued" : ""}`,
      );
    } catch (e) {
      this.put({ ...this.state.get(rec.key)!, status: "failed", failedStep: "refresh", lastError: (e as Error).message, lastAttemptAt: this.now().toISOString() });
      this.log(`${rec.key}: refresh failed: ${(e as Error).message}`);
    }
  }

  private async review(key: string): Promise<void> {
    let rec = this.state.get(key)!;
    rec = this.put({ ...rec, status: "reviewing", attempts: rec.attempts + 1, lastAttemptAt: this.now().toISOString() });
    const headAtStart = rec.headSha!;
    this.log(`${key}: AI ${rec.job === "rereview" ? "re-review" : "review"} started`);
    try {
      await this.worktrees.reset(rec.worktree!);
      const review = readReview(rec.reviewFile!);
      const prompt =
        rec.job === "rereview" && rec.previousHead
          ? rereviewPrompt(
              review,
              { previousHead: rec.previousHead, ...(rec.refresh ?? { newHunks: 0, relocated: 0, outdated: 0 }) },
              { worktree: true, findings: rec.findings },
            )
          : undefined;
      const run = this.opts.runAi ?? runAi;
      const sessionDir = join(this.config.root, "sessions", rec.owner, rec.repo, `pr-${rec.number}`);
      const result = await run({
        file: rec.reviewFile!,
        cwd: rec.worktree!,
        findings: rec.findings,
        readOnly: true,
        sessionDir,
        log: (line) => this.log(`${key}: ${line}`),
        ...(rec.sessionFile ? { sessionFile: rec.sessionFile } : {}),
        ...(prompt ? { prompt } : {}),
        ...(this.config.model ? { model: this.config.model } : {}),
        ...this.opts.ai,
      });
      const fresh = this.state.get(key)!;
      const done: PrRecord = { ...fresh, status: "ready", reviewedHead: headAtStart, attempts: 0, lastSummary: result.summary };
      if (result.sessionFile) done.sessionFile = result.sessionFile;
      delete done.lastError;
      delete done.failedStep;
      this.put(done);
      this.log(`${key}: AI review done${result.summary ? `: ${result.summary}` : ""}`);
    } catch (e) {
      const fresh = this.state.get(key)!;
      this.put({ ...fresh, status: "failed", failedStep: "review", lastError: (e as Error).message });
      this.log(`${key}: AI review failed: ${(e as Error).message}`);
    }
  }

  /** Remove the worktree now; keep the review file and session for `retainDays`. */
  private async close(rec: PrRecord, merged: boolean): Promise<void> {
    await this.worktrees.remove(rec.owner, rec.repo, rec.number);
    const closed: PrRecord = { ...rec, status: "closed", merged, closedAt: this.now().toISOString() };
    delete closed.worktree;
    delete closed.pendingHead;
    delete closed.pendingSince;
    this.put(closed);
    this.log(`${rec.key}: ${merged ? "merged" : "closed"}; worktree removed, review kept for ${this.config.retainDays} days`);
  }

  /** Delete everything left for a record. */
  async purge(rec: PrRecord): Promise<void> {
    if (rec.worktree || rec.status !== "closed") await this.worktrees.remove(rec.owner, rec.repo, rec.number);
    if (rec.reviewFile) rmSync(rec.reviewFile, { force: true });
    if (rec.sessionFile) rmSync(rec.sessionFile, { force: true });
    rmSync(join(this.config.root, "sessions", rec.owner, rec.repo, `pr-${rec.number}`), { recursive: true, force: true });
    this.state.remove(rec.key);
    this.log(`${rec.key}: removed`);
  }

  /** `greview watch clean`: purge closed and paused reviews now. */
  async clean(): Promise<string[]> {
    const purged: string[] = [];
    for (const rec of this.state.all()) {
      if (rec.status === "closed" || rec.status === "paused" || rec.status === "skipped") {
        await this.purge(rec);
        purged.push(rec.key);
      }
    }
    await this.recover();
    return purged;
  }
}
