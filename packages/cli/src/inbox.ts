/** Inbox entries for `greview inbox` / `greview watch --serve`, from the watch state. */
import { existsSync } from "node:fs";
import { readReview } from "@reviewexplainer/core";
import { StateStore, type PrRecord } from "@reviewexplainer/watch";
import type { ReviewSource } from "./serve.ts";

export interface InboxEntry {
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  status: PrRecord["status"];
  filters: string[];
  headSha?: string;
  reviewedHead?: string;
  pendingHead?: string;
  openThreads: number;
  aiFindings: number;
  viewed: number;
  total: number;
  lastSummary?: string;
  lastError?: string;
  changedAt: string;
  merged?: boolean;
}

export function inboxEntries(store: StateStore): InboxEntry[] {
  return store
    .all()
    .filter((r) => r.status !== "skipped" && r.reviewFile && existsSync(r.reviewFile))
    .map((r) => {
      let openThreads = 0;
      let aiFindings = 0;
      let viewed = 0;
      let total = 0;
      try {
        const review = readReview(r.reviewFile!);
        openThreads = review.threads.filter((t) => t.status === "open").length;
        aiFindings = review.threads.filter((t) => t.status === "open" && t.source === "ai").length;
        total = review.files.reduce((n, f) => n + Math.max(1, f.hunks.length), 0);
        viewed = Math.min(total, Object.keys(review.state.viewed).length);
      } catch {
        // A file mid-write: show the entry without counts.
      }
      const entry: InboxEntry = {
        key: r.key,
        repo: `${r.owner}/${r.repo}`,
        number: r.number,
        title: r.title,
        url: r.url,
        status: r.status,
        filters: r.filters,
        openThreads,
        aiFindings,
        viewed,
        total,
        changedAt: r.changedAt,
      };
      if (r.headSha) entry.headSha = r.headSha;
      if (r.reviewedHead) entry.reviewedHead = r.reviewedHead;
      if (r.pendingHead) entry.pendingHead = r.pendingHead;
      if (r.lastSummary) entry.lastSummary = r.lastSummary;
      if (r.lastError) entry.lastError = r.lastError;
      if (r.merged !== undefined) entry.merged = r.merged;
      return entry;
    })
    .sort((a, b) => b.changedAt.localeCompare(a.changedAt));
}

export function inboxSource(store: StateStore): ReviewSource {
  return {
    mode: "inbox",
    resolve: (key) => (key ? store.get(key)?.reviewFile : undefined),
    list: () => inboxEntries(store),
  };
}
