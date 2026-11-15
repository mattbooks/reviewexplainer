import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  git,
  githubRepo,
  loadConfig,
  readReview,
  repoRoot,
  reviewPath,
  type GreviewConfig,
} from "@reviewexplainer/core";

export interface RepoContext {
  root?: string;
  config: GreviewConfig;
  repo?: { owner: string; name: string };
}

export async function repoContext(cwd: string): Promise<RepoContext> {
  let root: string | undefined;
  try {
    root = await repoRoot(cwd);
  } catch {
    root = undefined;
  }
  const config = loadConfig(root);
  const repo = root ? await githubRepo(root) : undefined;
  return { root, config, ...(repo ? { repo } : {}) };
}

export function outputPath(ctx: RepoContext, key: { head: string; pr?: number }, out?: string): string {
  if (out) return resolve(out);
  return reviewPath(
    ctx.config,
    { ...key, ...(ctx.repo ? { owner: ctx.repo.owner, repo: ctx.repo.name } : {}) },
    ctx.root,
  );
}

/**
 * Find the review for the current checkout when no file is given: the newest
 * review in the storage folder whose head ref or sha matches HEAD.
 */
export async function locateReview(cwd: string, explicit?: string): Promise<string> {
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new Error(`${path} does not exist`);
    return path;
  }
  if (process.env.GREVIEW_FILE) return resolve(process.env.GREVIEW_FILE);
  const ctx = await repoContext(cwd);
  if (!ctx.root) throw new Error("Not in a git repository; pass the review file path");
  const dir = dirname(outputPath(ctx, { head: "0000000000000000" }));
  if (!existsSync(dir)) throw new Error(`No reviews in ${dir} yet; run \`greview init\` first`);
  const head = (await git(ctx.root, "rev-parse", "HEAD")).trim();
  let branch = "";
  try {
    branch = (await git(ctx.root, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  } catch {
    branch = "";
  }
  const candidates = readdirSync(dir)
    .filter((f) => /\.review\.json(\.gz)?$/.test(f))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (candidates.length === 0) throw new Error(`No reviews in ${dir} yet; run \`greview init\` first`);
  for (const path of candidates) {
    try {
      const r = readReview(path);
      if (r.subject.head.sha === head || (branch && branch !== "HEAD" && r.subject.head.ref === branch)) return path;
    } catch {
      // skip unreadable files
    }
  }
  throw new Error(
    `No review in ${dir} matches the current checkout (${branch || head.slice(0, 12)}). Pass the file path, or run \`greview init\`.`,
  );
}
