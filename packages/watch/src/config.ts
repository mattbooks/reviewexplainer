import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cacheDir, loadConfig } from "@reviewexplainer/core";

export interface WatchFilter {
  /** Short name shown in logs and the inbox. */
  name: string;
  /** GitHub search query; `is:pr` is added. E.g. `is:open review-requested:@me -is:draft`. */
  query: string;
  /** Run the AI review (default true). */
  ai: boolean;
  /** Ask the AI for findings, not just the guide (default true). */
  findings: boolean;
}

export interface WatchConfig {
  filters: WatchFilter[];
  /** Seconds between polls (default 120). */
  intervalSeconds: number;
  /** Wait this long after a push before re-reviewing, since pushes come in bursts (default 180). */
  settleSeconds: number;
  /** AI reviews running at once (default 1). */
  concurrency: number;
  /** Keep the review file and AI session this many days after a PR closes (default 7). */
  retainDays: number;
  /** Where clones, worktrees, sessions and state live (default ~/.cache/greview/watch). */
  root: string;
  /** provider/model-id for the AI; default pi's default model. */
  model?: string;
}

const DEFAULTS = { intervalSeconds: 120, settleSeconds: 180, concurrency: 1, retainDays: 7 };

function expand(path: string): string {
  return resolve(path.replace(/^~(?=$|\/)/, homedir()));
}

export function parseWatchConfig(raw: unknown): WatchConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error(
      'No "watch" settings. Add them to ~/.config/greview/config.json, e.g. {"watch": {"filters": [{"name": "mine", "query": "is:open review-requested:@me -is:draft"}]}}',
    );
  }
  const r = raw as Record<string, unknown>;
  const filters = r.filters;
  if (!Array.isArray(filters) || filters.length === 0) throw new Error('"watch.filters" needs at least one {"name", "query"}');
  const parsed: WatchFilter[] = filters.map((f, i) => {
    const o = f as Record<string, unknown>;
    if (typeof o?.query !== "string" || !o.query.trim()) throw new Error(`watch.filters[${i}] needs a "query"`);
    return {
      name: typeof o.name === "string" && o.name ? o.name : `filter ${i + 1}`,
      query: o.query.trim(),
      ai: o.ai !== false,
      findings: o.findings !== false,
    };
  });
  const num = (key: keyof typeof DEFAULTS, min: number) => {
    const v = r[key];
    if (v === undefined) return DEFAULTS[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min) throw new Error(`"watch.${key}" must be a number ≥ ${min}`);
    return v;
  };
  const config: WatchConfig = {
    filters: parsed,
    intervalSeconds: num("intervalSeconds", 15),
    settleSeconds: num("settleSeconds", 0),
    concurrency: Math.floor(num("concurrency", 1)),
    retainDays: num("retainDays", 0),
    root: typeof r.root === "string" && r.root ? expand(r.root) : join(cacheDir(), "watch"),
  };
  if (typeof r.model === "string" && r.model) config.model = r.model;
  return config;
}

/** Watch settings come from the user config only: a repository's own config is untrusted here. */
export function loadWatchConfig(): WatchConfig {
  const config = loadConfig(undefined);
  const watch = config.watch as Record<string, unknown> | undefined;
  return parseWatchConfig(watch && !watch.model && config.model ? { ...watch, model: config.model } : watch);
}
