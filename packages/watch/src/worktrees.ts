/**
 * One bare clone per repository, plus a disposable checkout per pull request.
 *
 * A PR's checkout is a `git clone --shared` of the mirror whose git directory
 * lives outside the working tree (see core/checkout.ts), so an agent with a
 * shell can change the working tree but not the git config, hooks or refs
 * that the watcher later runs git against. Checkouts are reset before every
 * AI run and removed when the PR closes.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { git, prepareCheckout, removeCheckout, resetCheckout, type Checkout, type CheckoutPaths } from "@reviewexplainer/core";

export type RemoteUrl = (owner: string, repo: string, cloneUrl: string) => string;

export class Worktrees {
  readonly reposDir: string;
  readonly worktreesDir: string;
  readonly gitDirsDir: string;
  readonly scratchDir: string;

  constructor(
    root: string,
    private remoteUrl: RemoteUrl = (_o, _r, url) => url,
  ) {
    this.reposDir = join(root, "repos");
    this.worktreesDir = join(root, "worktrees");
    this.gitDirsDir = join(root, "gitdirs");
    this.scratchDir = join(root, "scratch");
    for (const d of [this.reposDir, this.worktreesDir, this.gitDirsDir, this.scratchDir]) mkdirSync(d, { recursive: true });
  }

  mirror(owner: string, repo: string): string {
    return join(this.reposDir, owner, `${repo}.git`);
  }

  path(owner: string, repo: string, number: number): string {
    return join(this.worktreesDir, owner, repo, `pr-${number}`);
  }

  paths(owner: string, repo: string, number: number): CheckoutPaths {
    const rel = join(owner, repo, `pr-${number}`);
    return { dir: join(this.worktreesDir, rel), gitDir: join(this.gitDirsDir, rel), scratch: join(this.scratchDir, rel) };
  }

  /** Checkout paths for a working-tree path (as stored in PR records). */
  private pathsFor(dir: string): CheckoutPaths {
    const rel = resolve(dir).slice(resolve(this.worktreesDir).length + 1);
    return { dir: resolve(dir), gitDir: join(this.gitDirsDir, rel), scratch: join(this.scratchDir, rel) };
  }

  async ensureMirror(owner: string, repo: string, cloneUrl: string): Promise<string> {
    const mirror = this.mirror(owner, repo);
    if (!existsSync(join(mirror, "HEAD"))) {
      rmSync(mirror, { recursive: true, force: true });
      mkdirSync(dirname(mirror), { recursive: true });
      await git(this.reposDir, "clone", "--bare", "--quiet", this.remoteUrl(owner, repo, cloneUrl), mirror);
    }
    return mirror;
  }

  /** Fetch the PR head and its base branch into refs/greview/. */
  async fetchPr(owner: string, repo: string, number: number, baseRef: string): Promise<void> {
    await git(
      this.mirror(owner, repo),
      "fetch",
      "--quiet",
      "--no-tags",
      "--force",
      "origin",
      `+refs/pull/${number}/head:refs/greview/pr/${number}`,
      `+refs/heads/${baseRef}:refs/greview/base/${number}`,
    );
  }

  /** Create the checkout at `sha`, or move an existing one there. */
  async checkout(owner: string, repo: string, number: number, sha: string): Promise<string> {
    return (await this.open(owner, repo, number, sha)).dir;
  }

  /** The checkout with what the sandbox needs to know about it. */
  async open(owner: string, repo: string, number: number, sha: string): Promise<Checkout> {
    const paths = this.paths(owner, repo, number);
    // A checkout from before checkouts had their own git dir: start over.
    if (existsSync(join(paths.dir, ".git")) && !existsSync(join(paths.gitDir, "HEAD"))) await this.removeLegacy(owner, repo, paths.dir);
    return prepareCheckout(this.mirror(owner, repo), sha, paths);
  }

  /** Throw away anything an agent changed. */
  async reset(path: string): Promise<void> {
    await resetCheckout(this.pathsFor(path));
  }

  private async removeLegacy(owner: string, repo: string, dir: string): Promise<void> {
    const mirror = this.mirror(owner, repo);
    if (existsSync(mirror)) await git(mirror, "worktree", "remove", "--force", dir).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    if (existsSync(mirror)) await git(mirror, "worktree", "prune").catch(() => undefined);
  }

  async remove(owner: string, repo: string, number: number): Promise<void> {
    const mirror = this.mirror(owner, repo);
    const paths = this.paths(owner, repo, number);
    if (existsSync(mirror)) {
      await git(mirror, "worktree", "remove", "--force", paths.dir).catch(() => undefined);
      for (const ref of [`refs/greview/pr/${number}`, `refs/greview/base/${number}`]) {
        await git(mirror, "update-ref", "-d", ref).catch(() => undefined);
      }
    }
    removeCheckout(paths);
    if (existsSync(mirror)) await git(mirror, "worktree", "prune").catch(() => undefined);
  }

  /**
   * Remove checkouts that no record owns: left over from a crash, or from a
   * record that was deleted. Returns the paths removed.
   */
  async pruneOrphans(keep: Set<string>): Promise<string[]> {
    const removed: string[] = [];
    const kept = new Set([...keep].map((p) => resolve(p)));
    for (const owner of existsSync(this.reposDir) ? readdirSync(this.reposDir) : []) {
      for (const repoDir of readdirSync(join(this.reposDir, owner))) {
        await git(join(this.reposDir, owner, repoDir), "worktree", "prune").catch(() => undefined);
      }
    }
    for (const base of [this.worktreesDir, this.gitDirsDir, this.scratchDir]) {
      for (const owner of readdirSync(base)) {
        for (const repo of readdirSync(join(base, owner))) {
          for (const pr of readdirSync(join(base, owner, repo))) {
            const dir = resolve(join(this.worktreesDir, owner, repo, pr));
            if (kept.has(dir)) continue;
            rmSync(join(base, owner, repo, pr), { recursive: true, force: true });
            if (!removed.includes(dir)) removed.push(dir);
          }
        }
      }
    }
    return removed;
  }
}
