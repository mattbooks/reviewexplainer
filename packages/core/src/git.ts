import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function run(cmd: string, args: string[], cwd: string, input?: string): Promise<string> {
  if (input !== undefined) {
    return new Promise((resolve, reject) => {
      const child = execFile(cmd, args, { cwd, maxBuffer: 512 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
        else resolve(stdout);
      });
      child.stdin?.end(input);
    });
  }
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd, maxBuffer: 512 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`${cmd} ${args.join(" ")} failed: ${(err.stderr || err.message).trim()}`);
  }
}

export function git(cwd: string, ...args: string[]): Promise<string> {
  return run("git", args, cwd);
}

export async function revParse(cwd: string, rev: string): Promise<string> {
  return (await git(cwd, "rev-parse", "--verify", `${rev}^{commit}`)).trim();
}

/** Top of the working tree, or the git directory itself for a bare repository. */
export async function repoRoot(cwd: string): Promise<string> {
  if ((await git(cwd, "rev-parse", "--is-bare-repository")).trim() === "true") {
    return (await git(cwd, "rev-parse", "--absolute-git-dir")).trim();
  }
  return (await git(cwd, "rev-parse", "--show-toplevel")).trim();
}

/** Parse owner/name from a GitHub remote URL (https or ssh). */
export function parseGitHubRemote(url: string): { owner: string; name: string } | undefined {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, name: m[2]! } : undefined;
}

export async function githubRepo(cwd: string, remote = "origin"): Promise<{ owner: string; name: string } | undefined> {
  try {
    return parseGitHubRemote(await git(cwd, "remote", "get-url", remote));
  } catch {
    return undefined;
  }
}

export interface DiffResult {
  patch: string;
  baseSha: string;
  headSha: string;
  mergeBase: string;
}

/**
 * Diff from the merge base of base and head to head, like a pull request.
 * Renames are detected; output always uses a/ and b/ prefixes.
 */
export async function collectDiff(cwd: string, base: string, head: string): Promise<DiffResult> {
  const baseSha = await revParse(cwd, base);
  const headSha = await revParse(cwd, head);
  const mergeBase = (await git(cwd, "merge-base", baseSha, headSha)).trim();
  const patch = await git(
    cwd,
    "-c",
    "core.quotepath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "-M",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    mergeBase,
    headSha,
  );
  return { patch, baseSha, headSha, mergeBase };
}

/** File contents at a commit, or undefined if the file does not exist there. */
export async function showFile(cwd: string, sha: string, path: string): Promise<string | undefined> {
  try {
    return await git(cwd, "show", `${sha}:${path}`);
  } catch {
    return undefined;
  }
}

/**
 * Paths git attributes mark as linguist-generated or linguist-vendored. With
 * `source`, attributes are read from that commit (works in bare repositories).
 */
export async function attributeFlags(cwd: string, paths: string[], source?: string): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (paths.length === 0) return out;
  const check = (withSource: boolean) =>
    run(
      "git",
      ["check-attr", ...(withSource && source ? [`--source=${source}`] : []), "--stdin", "-z", "linguist-generated", "linguist-vendored", "linguist-documentation"],
      cwd,
      paths.join("\0") + "\0",
    );
  try {
    // --source needs git 2.40; older git reads the working tree's attributes.
    const text = await check(true).catch(() => check(false));
    const parts = text.split("\0");
    for (let i = 0; i + 2 < parts.length; i += 3) {
      const [path, attr, value] = [parts[i]!, parts[i + 1]!, parts[i + 2]!];
      if (value === "set" || value === "true") {
        const set = out.get(path) ?? new Set<string>();
        set.add(attr);
        out.set(path, set);
      }
    }
  } catch {
    // Not fatal: fall back to path patterns.
  }
  return out;
}
