/**
 * Where review files live. Configured by `storage` in `.greview.json` (repo)
 * or `~/.config/greview/config.json` (user); `--out` overrides per run.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type StorageMode = "cache" | "repo" | "path";

export interface GreviewConfig {
  storage: StorageMode;
  /** For storage "path": a path template with {owner} {repo} {pr} {head} {name}. */
  path?: string;
  /** Default reviewer name for local comments. */
  reviewer?: string;
  /** Model override for `greview ai`, as provider/model-id. Default: pi's default model. */
  model?: string;
  /** Settings for `greview watch` (validated by the watch package). User config only. */
  watch?: unknown;
}

const DEFAULTS: GreviewConfig = { storage: "cache" };

function readJson(path: string): Partial<GreviewConfig> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<GreviewConfig>;
  } catch (e) {
    throw new Error(`Could not parse ${path}: ${(e as Error).message}`);
  }
}

export function userConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "greview", "config.json");
}

export function loadConfig(repoRoot: string | undefined): GreviewConfig {
  const user = readJson(userConfigPath());
  const repo = repoRoot ? readJson(join(repoRoot, ".greview.json")) : {};
  const merged = { ...DEFAULTS, ...user, ...repo };
  if (!["cache", "repo", "path"].includes(merged.storage)) {
    throw new Error(`Unknown storage "${merged.storage}"; use cache, repo or path`);
  }
  if (merged.storage === "path" && !merged.path) throw new Error('storage "path" needs a "path" template');
  return merged;
}

export interface ReviewKey {
  owner?: string;
  repo?: string;
  pr?: number;
  head: string;
}

function reviewName(key: ReviewKey): string {
  return key.pr ? `pr-${key.pr}` : key.head.slice(0, 12);
}

export function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "greview");
}

export function reviewPath(config: GreviewConfig, key: ReviewKey, repoRoot?: string): string {
  const name = reviewName(key);
  switch (config.storage) {
    case "cache":
      return join(cacheDir(), key.owner ?? "local", key.repo ?? "repo", `${name}.review.json`);
    case "repo":
      return join(repoRoot ?? process.cwd(), ".reviews", `${name}.review.json`);
    case "path": {
      const filled = config
        .path!.replace(/\{owner\}/g, key.owner ?? "local")
        .replace(/\{repo\}/g, key.repo ?? "repo")
        .replace(/\{pr\}/g, key.pr ? String(key.pr) : "none")
        .replace(/\{head\}/g, key.head.slice(0, 12))
        .replace(/\{name\}/g, name);
      return resolve(repoRoot ?? process.cwd(), filled);
    }
  }
}
