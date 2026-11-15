/**
 * Disposable checkouts for AI reviews.
 *
 * The agent works in a `git clone --shared` of the repository at the head
 * commit. The clone's git directory lives outside the working tree, and the
 * sandbox only gets read access to it, so nothing the agent does can change
 * git config, hooks or refs that greview (or you) later run git against.
 * Objects come from the source repository through alternates: the clone is
 * fast and small, and the source's objects are mounted read-only.
 *
 * greview's own git commands on a checkout always pass --git-dir and
 * --work-tree explicitly instead of discovering `.git`, because the agent can
 * rewrite the `.git` file in the working tree.
 */
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { git } from "./git.ts";

export interface CheckoutPaths {
  /** Working tree the agent sees (read/write in the sandbox). */
  dir: string;
  /** The clone's git directory (read-only in the sandbox). */
  gitDir: string;
  /** Scratch space for temp files and caches (read/write in the sandbox). */
  scratch: string;
}

export interface Checkout extends CheckoutPaths {
  /** Git directories the sandbox needs to read: this clone's and the source objects. */
  readOnlyDirs: string[];
  /** Run git against this checkout (never discovers `.git`). */
  git(...args: string[]): Promise<string>;
}

/** Directories the alternates file points at (the source repository's objects). */
async function objectDirs(source: string): Promise<string[]> {
  const common = (await git(source, "rev-parse", "--git-common-dir")).trim();
  const abs = isAbsolute(common) ? common : resolve(source, common);
  return [join(abs, "objects")];
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function checkoutGit(paths: Pick<CheckoutPaths, "dir" | "gitDir">) {
  return (...args: string[]) =>
    git(paths.dir, `--git-dir=${paths.gitDir}`, `--work-tree=${paths.dir}`, "-c", "core.hooksPath=/dev/null", ...args);
}

/**
 * Create the checkout at `sha`, or move an existing one there and throw away
 * anything an agent changed. `source` is any repository (bare or not) that has
 * the commit.
 */
export async function prepareCheckout(source: string, sha: string, paths: CheckoutPaths): Promise<Checkout> {
  const run = checkoutGit(paths);
  const fresh = !existsSync(join(paths.gitDir, "HEAD"));
  if (fresh) {
    rmSync(paths.dir, { recursive: true, force: true });
    rmSync(paths.gitDir, { recursive: true, force: true });
    mkdirSync(dirname(paths.dir), { recursive: true });
    mkdirSync(dirname(paths.gitDir), { recursive: true });
    await git(dirname(paths.dir), "clone", "--quiet", "--shared", "--no-checkout", `--separate-git-dir=${paths.gitDir}`, source, paths.dir);
  }
  mkdirSync(paths.dir, { recursive: true });
  await run("checkout", "--quiet", "--detach", "--force", sha);
  await run("clean", "-fdxq");
  rmSync(paths.scratch, { recursive: true, force: true });
  for (const sub of ["tmp", "cache"]) mkdirSync(join(paths.scratch, sub), { recursive: true });
  return {
    dir: real(paths.dir),
    gitDir: real(paths.gitDir),
    scratch: real(paths.scratch),
    readOnlyDirs: [real(paths.gitDir), ...(await objectDirs(source)).map(real)],
    git: run,
  };
}

/** Throw away anything an agent changed, keeping the commit. */
export async function resetCheckout(paths: Pick<CheckoutPaths, "dir" | "gitDir">): Promise<void> {
  const run = checkoutGit(paths);
  await run("reset", "--quiet", "--hard");
  await run("clean", "-fdxq");
}

export function removeCheckout(paths: CheckoutPaths): void {
  for (const p of [paths.dir, paths.gitDir, paths.scratch]) rmSync(p, { recursive: true, force: true });
}
