/**
 * One small JSON file per tracked pull request. Written atomically, so a
 * crash leaves either the old or the new record, and `recover()` can bring
 * everything back in line with what is on disk.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PrStatus =
  /** Clone, worktree and review file being created. */
  | "preparing"
  /** Waiting for an AI slot. */
  | "queued"
  /** The AI is working on it. */
  | "reviewing"
  /** Up to date. */
  | "ready"
  | "failed"
  /** Still open but no longer matches any filter. */
  | "paused"
  /** Closed or merged: worktree removed, review kept for a while. */
  | "closed"
  /** Never reviewed (e.g. from a fork). */
  | "skipped";

export interface PrRecord {
  key: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  filters: string[];
  ai: boolean;
  findings: boolean;
  status: PrStatus;
  skipReason?: string;
  /** Head commit checked out in the worktree and described by the review file. */
  headSha?: string;
  /** Head commit the AI last finished reviewing. */
  reviewedHead?: string;
  /** A newer head waiting for the settle time to pass. */
  pendingHead?: string;
  pendingSince?: string;
  /** The PR's updated_at when we last looked at it. */
  updatedAt?: string;
  worktree?: string;
  reviewFile?: string;
  sessionFile?: string;
  job?: "review" | "rereview";
  previousHead?: string;
  refresh?: { newHunks: number; relocated: number; outdated: number };
  failedStep?: "prepare" | "review" | "refresh";
  attempts: number;
  lastError?: string;
  lastAttemptAt?: string;
  lastSummary?: string;
  createdAt: string;
  changedAt: string;
  pausedAt?: string;
  closedAt?: string;
  merged?: boolean;
}

export function prKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

export class StateStore {
  readonly dir: string;

  constructor(root: string) {
    this.dir = join(root, "state");
    mkdirSync(this.dir, { recursive: true });
  }

  private file(key: string): string {
    return join(this.dir, `${key.replace(/[/#]/g, "__")}.json`);
  }

  get(key: string): PrRecord | undefined {
    const path = this.file(key);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as PrRecord;
  }

  put(record: PrRecord): PrRecord {
    const next = { ...record, changedAt: new Date().toISOString() };
    const path = this.file(record.key);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, path);
    return next;
  }

  remove(key: string): void {
    rmSync(this.file(key), { force: true });
  }

  all(): PrRecord[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.dir, f), "utf8")) as PrRecord;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is PrRecord => Boolean(r))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
}
