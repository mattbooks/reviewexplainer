/**
 * One bare clone per repository, shared by a worktree per pull request.
 * Worktrees are disposable: they are reset before every AI run and removed
 * when the PR closes.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { git } from "@reviewexplainer/core";

export type RemoteUrl = (owner: string, repo: string, cloneUrl: string) => string;

export class Worktrees {
  readonly reposDir: string;
  readonly worktreesDir: string;

  constructor(
    root: string,
    private remoteUrl: RemoteUrl = (_o, _r, url) => url,
  ) {
    this.reposDir = join(root, "repos");
    this.worktreesDir = join(root, "worktrees");
    mkdirSync(this.reposDir, { recursive: true });
    mkdirSync(this.worktreesDir, { recursive: true });
  }

  mirror(owner: string, repo: string): string {
    return join(this.reposDir, owner, `${repo}.git`);
  }

  path(owner: string, repo: string, number: number): string {
    return join(this.worktreesDir, owner, repo, `pr-${number}`);
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

  /** Create the worktree at `sha`, or move an existing one there. */
  async checkout(owner: string, repo: string, number: number, sha: string): Promise<string> {
    const path = this.path(owner, repo, number);
    if (existsSync(join(path, ".git"))) {
      await git(path, "checkout", "--quiet", "--detach", "--force", sha);
      await git(path, "clean", "-fdxq");
    } else {
      rmSync(path, { recursive: true, force: true });
      mkdirSync(dirname(path), { recursive: true });
      await git(this.mirror(owner, repo), "worktree", "add", "--quiet", "--detach", "--force", path, sha);
    }
    return path;
  }

  /** Throw away anything an agent changed. */
  async reset(path: string): Promise<void> {
    await git(path, "reset", "--quiet", "--hard");
    await git(path, "clean", "-fdxq");
  }

  async remove(owner: string, repo: string, number: number): Promise<void> {
    const mirror = this.mirror(owner, repo);
    const path = this.path(owner, repo, number);
    if (existsSync(mirror)) {
      try {
        await git(mirror, "worktree", "remove", "--force", path);
      } catch {
        // Not registered (or already gone): remove the directory below.
      }
      for (const ref of [`refs/greview/pr/${number}`, `refs/greview/base/${number}`]) {
        try {
          await git(mirror, "update-ref", "-d", ref);
        } catch {
          // ref may not exist
        }
      }
    }
    rmSync(path, { recursive: true, force: true });
    if (existsSync(mirror)) await git(mirror, "worktree", "prune");
  }

  /**
   * Remove worktrees that no record owns: left over from a crash, or from a
   * record that was deleted. Returns the paths removed.
   */
  async pruneOrphans(keep: Set<string>): Promise<string[]> {
    const removed: string[] = [];
    const kept = new Set([...keep].map((p) => resolve(p)));
    for (const owner of existsSync(this.reposDir) ? readdirSync(this.reposDir) : []) {
      for (const repoDir of readdirSync(join(this.reposDir, owner))) {
        const mirror = join(this.reposDir, owner, repoDir);
        await git(mirror, "worktree", "prune");
        const listing = await git(mirror, "worktree", "list", "--porcelain");
        for (const line of listing.split("\n")) {
          if (!line.startsWith("worktree ")) continue;
          const path = resolve(line.slice(9));
          if (!path.startsWith(this.worktreesDir + sep) || kept.has(path)) continue;
          await git(mirror, "worktree", "remove", "--force", path).catch(() => undefined);
          rmSync(path, { recursive: true, force: true });
          removed.push(path);
        }
      }
    }
    // Directories git no longer knows about.
    for (const owner of readdirSync(this.worktreesDir)) {
      for (const repo of readdirSync(join(this.worktreesDir, owner))) {
        for (const pr of readdirSync(join(this.worktreesDir, owner, repo))) {
          const path = resolve(join(this.worktreesDir, owner, repo, pr));
          if (!kept.has(path) && !removed.includes(path)) {
            rmSync(path, { recursive: true, force: true });
            removed.push(path);
          }
        }
      }
    }
    return removed;
  }
}
