/**
 * How AI reviews run the code they review.
 *
 * Modes:
 *   safehouse  bash and read run inside agent-safehouse (macOS Seatbelt). The
 *              agent can build the code and run tests; it can write only the
 *              checkout and a scratch directory, and it starts with a clean
 *              environment (no API keys, no tokens).
 *   readonly   No shell. read, grep, find and ls, confined to the checkout.
 *   none       pi's normal tools, unsandboxed. Only for code you trust.
 *   auto       safehouse when it is installed, otherwise readonly (default).
 *
 * The model loop itself (and pi's credentials) always stays outside the
 * sandbox: only tool calls go in.
 *
 * Settings come from the user config only (`sandbox` in
 * ~/.config/greview/config.json): a repository under review must not be able
 * to loosen them.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, relative, resolve, sep, isAbsolute } from "node:path";
import {
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "@reviewexplainer/core";

export type SandboxMode = "auto" | "safehouse" | "readonly" | "none";

export interface SandboxSettings {
  mode: SandboxMode;
  /** The safehouse executable (default: `safehouse` on PATH). Any wrapper with the same arguments works. */
  command?: string;
  /** Environment variables to pass into the sandbox from greview's environment (none by default). */
  envPass?: string[];
  /** Fixed environment variables for commands in the sandbox. */
  env?: Record<string, string>;
  /** Extra directories the sandbox may write (e.g. a shared build cache). */
  addDirs?: string[];
  /** Extra directories the sandbox may read. */
  addDirsRo?: string[];
  /** safehouse features to turn on, e.g. ["docker"]. */
  enable?: string[];
  /** Extra Seatbelt profiles appended after greview's (they win). */
  appendProfiles?: string[];
  /** Seconds before a single command is killed (default 600). */
  commandTimeoutSeconds?: number;
}

export type SandboxKind = "safehouse" | "readonly" | "none";

export interface SandboxPlan {
  kind: SandboxKind;
  /** Resolved executable for safehouse. */
  command?: string;
  /** Why auto did not pick safehouse, to show the user. */
  note?: string;
  settings: SandboxSettings;
}

/** What a review run is allowed to touch. */
export interface SandboxScope {
  /** Working directory (read/write). */
  workdir: string;
  /** Scratch directory for TMPDIR and caches (read/write). */
  scratch: string;
  /** Extra read-only directories (the checkout's git dir and objects). */
  readOnlyDirs: string[];
  /** Extra Seatbelt rules, e.g. to protect a .git directory inside the workdir. */
  profile?: string;
}

const MODES: SandboxMode[] = ["auto", "safehouse", "readonly", "none"];

function strings(v: unknown, key: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`"sandbox.${key}" must be a list of strings`);
  return v as string[];
}

export function parseSandboxSettings(raw: unknown): SandboxSettings {
  if (raw === undefined || raw === null) return { mode: "auto" };
  if (typeof raw === "string") raw = { mode: raw };
  if (typeof raw !== "object") throw new Error('"sandbox" must be an object like {"mode": "safehouse"}');
  const r = raw as Record<string, unknown>;
  const mode = (r.mode ?? "auto") as SandboxMode;
  if (!MODES.includes(mode)) throw new Error(`Unknown sandbox mode "${String(r.mode)}"; use ${MODES.join(", ")}`);
  const out: SandboxSettings = { mode };
  if (r.command !== undefined) {
    if (typeof r.command !== "string" || !r.command) throw new Error('"sandbox.command" must be a path');
    out.command = r.command;
  }
  const envPass = strings(r.envPass, "envPass");
  if (envPass) out.envPass = envPass;
  for (const key of ["addDirs", "addDirsRo", "enable", "appendProfiles"] as const) {
    const list = strings(r[key], key);
    if (list) out[key] = list;
  }
  if (r.env !== undefined) {
    if (!r.env || typeof r.env !== "object" || Object.values(r.env).some((v) => typeof v !== "string")) {
      throw new Error('"sandbox.env" must map names to strings');
    }
    out.env = r.env as Record<string, string>;
  }
  if (r.commandTimeoutSeconds !== undefined) {
    if (typeof r.commandTimeoutSeconds !== "number" || r.commandTimeoutSeconds <= 0) {
      throw new Error('"sandbox.commandTimeoutSeconds" must be a positive number');
    }
    out.commandTimeoutSeconds = r.commandTimeoutSeconds;
  }
  return out;
}

/** Sandbox settings from the user config (never the repository's). */
export function loadSandboxSettings(): SandboxSettings {
  return parseSandboxSettings(loadConfig(undefined).sandbox);
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  which?: (name: string) => string | undefined;
}

/**
 * Turn settings into what will actually run. Throws when safehouse was asked
 * for explicitly and cannot run, so a review never silently loses its sandbox.
 */
export function resolveSandbox(settings: SandboxSettings, opts: ResolveOptions = {}): SandboxPlan {
  const platform = opts.platform ?? process.platform;
  const which = opts.which ?? onPath;
  if (settings.mode === "none" || settings.mode === "readonly") return { kind: settings.mode, settings };
  const explicit = settings.command;
  const command = explicit ? (isAbsolute(explicit) || explicit.includes(sep) ? (existsSync(explicit) ? explicit : undefined) : which(explicit)) : which("safehouse");
  const problem = !command
    ? `${explicit ?? "safehouse"} was not found. Install it with \`brew install eugene1g/safehouse/agent-safehouse\`.`
    : !explicit && platform !== "darwin"
      ? "agent-safehouse only runs on macOS."
      : undefined;
  if (!problem) return { kind: "safehouse", command: command!, settings };
  if (settings.mode === "safehouse") throw new Error(`The sandbox is set to safehouse, but ${problem}`);
  return { kind: "readonly", settings, note: `Running without a shell: ${problem}` };
}

// ---------------------------------------------------------------------------
// safehouse invocation

function realOr(path: string): string {
  const expanded = path.replace(/^~(?=$|\/)/, homedir());
  try {
    return realpathSync(expanded);
  } catch {
    return resolve(expanded);
  }
}

function sbString(path: string): string {
  return JSON.stringify(path);
}

/**
 * Seatbelt rules that keep the agent from rewriting the git directory of a
 * repository whose `.git` sits inside the workdir (the interactive /review
 * case). Config and hooks are code that runs outside the sandbox.
 */
export function protectGitDirProfile(gitDir: string): string {
  const g = realOr(gitDir);
  return [
    ";; greview: git config and hooks run outside the sandbox, so the agent may not change them",
    `(deny file-write* (literal ${sbString(join(g, "config"))}) (subpath ${sbString(join(g, "hooks"))}) (subpath ${sbString(join(g, "info"))}))`,
    "",
  ].join("\n");
}

export interface SafehouseCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Variables set inside the sandbox so tools write caches to the scratch dir. */
export function sandboxEnv(scope: SandboxScope, settings: SandboxSettings): Record<string, string> {
  const tmp = join(scope.scratch, "tmp");
  const cache = join(scope.scratch, "cache");
  return {
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: cache,
    npm_config_cache: join(cache, "npm"),
    YARN_CACHE_FOLDER: join(cache, "yarn"),
    PIP_CACHE_DIR: join(cache, "pip"),
    GOCACHE: join(cache, "go-build"),
    GOMODCACHE: join(cache, "go-mod"),
    CARGO_TARGET_DIR: join(scope.scratch, "cargo-target"),
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    NO_COLOR: "1",
    ...settings.env,
  };
}

/** Build the safehouse command line that runs `argv` in the sandbox. */
export function safehouseCommand(plan: SandboxPlan, scope: SandboxScope, argv: string[]): SafehouseCommand {
  if (plan.kind !== "safehouse" || !plan.command) throw new Error("safehouseCommand needs a safehouse plan");
  const settings = plan.settings;
  mkdirSync(join(scope.scratch, "tmp"), { recursive: true });
  mkdirSync(join(scope.scratch, "cache"), { recursive: true });
  const writable = [scope.scratch, ...(settings.addDirs ?? [])].map(realOr);
  const readable = [...scope.readOnlyDirs, ...(settings.addDirsRo ?? [])].map(realOr);
  const args = [`--workdir=${realOr(scope.workdir)}`, `--add-dirs=${writable.join(":")}`];
  if (readable.length) args.push(`--add-dirs-ro=${readable.join(":")}`);
  const pass = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", ...(settings.envPass ?? [])];
  args.push(`--env-pass=${[...new Set(pass)].join(",")}`);
  if (settings.enable?.length) args.push(`--enable=${settings.enable.join(",")}`);
  if (scope.profile) {
    const file = join(scope.scratch, "greview.sb");
    writeFileSync(file, scope.profile);
    args.push(`--append-profile=${file}`);
  }
  for (const p of settings.appendProfiles ?? []) args.push(`--append-profile=${realOr(p)}`);
  const inside = sandboxEnv(scope, settings);
  args.push("--", "/usr/bin/env", ...Object.entries(inside).map(([k, v]) => `${k}=${v}`), ...argv);

  // What safehouse itself sees: only the basics plus the names asked for, so
  // nothing secret reaches it even if a pass-through list is too broad.
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...pass, "PATH", "TERM"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { command: plan.command, args, env };
}

export interface ExecResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * Run `argv` in the sandbox. When the command exits, anything it left running
 * in the background is killed with it, so each command starts clean.
 */
export function runInSandbox(
  plan: SandboxPlan,
  scope: SandboxScope,
  argv: string[],
  opts: { signal?: AbortSignal; onData?: (data: Buffer) => void; timeoutMs?: number; cwd?: string } = {},
): Promise<ExecResult> {
  const cmd = safehouseCommand(plan, scope, argv);
  return new Promise((resolvePromise, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(cmd.command, cmd.args, { cwd: opts.cwd ?? scope.workdir, env: cmd.env, stdio: ["ignore", "pipe", "pipe"], detached });
    const out: Buffer[] = [];
    let err = "";
    let settled = false;
    let timedOut = false;
    const killGroup = () => {
      try {
        if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killGroup();
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => killGroup();
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => (opts.onData ? opts.onData(d) : out.push(d)));
    child.stderr.on("data", (d: Buffer) => (opts.onData ? opts.onData(d) : (err += d.toString())));
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    child.on("error", (e) => finish(() => reject(new Error(`Could not start ${cmd.command}: ${e.message}`))));
    child.on("exit", (code, signal) => {
      // Give the pipes a moment to drain, then stop background leftovers that
      // would otherwise hold them open forever.
      const close = () =>
        finish(() => {
          killGroup();
          child.stdout.destroy();
          child.stderr.destroy();
          resolvePromise({
            code: code ?? (signal ? 128 + 9 : 1),
            stdout: Buffer.concat(out),
            stderr: err,
            timedOut,
            aborted: Boolean(opts.signal?.aborted),
          });
        });
      const grace = setTimeout(close, 200);
      child.once("close", () => {
        clearTimeout(grace);
        close();
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tools

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Wrap a path-taking tool so it refuses anything outside `roots` after
 * resolving symlinks. Only sound when nothing the agent controls can change
 * the filesystem during the run (readonly mode: there is no shell).
 */
function confine<T extends ToolDefinition<any, any, any>>(tool: T, cwd: string, roots: string[]): T {
  const realRoots = roots.map(realOr);
  return {
    ...tool,
    async execute(id: string, params: any, ...rest: any[]) {
      const raw = typeof params?.path === "string" && params.path ? params.path : ".";
      const abs = resolve(cwd, raw.replace(/^@/, "").replace(/^~(?=$|\/)/, homedir()));
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        real = abs;
      }
      if (!realRoots.some((r) => inside(r, real))) {
        throw new Error(`${raw} is outside the checkout; only files under ${cwd} can be read`);
      }
      return (tool.execute as any)(id, params, ...rest);
    },
  } as T;
}

const BASH_GUIDELINES = [
  "Commands run in a sandbox: you can write the checkout and $TMPDIR only, and the environment has no credentials.",
  "Install dependencies with the project's lockfile (npm ci, pnpm install --frozen-lockfile, etc.) before running tests.",
  "Run focused tests or small scripts to confirm a suspected bug before you report it. Do not commit, push or edit files you are not using to test.",
];

/**
 * The exploration tools for a review run, as pi tool definitions that replace
 * the built-ins of the same name.
 */
export function sandboxTools(plan: SandboxPlan, scope: SandboxScope): ToolDefinition<any, any, any>[] {
  const cwd = scope.workdir;
  if (plan.kind === "none") {
    return [createReadToolDefinition(cwd), createGrepToolDefinition(cwd), createFindToolDefinition(cwd), createLsToolDefinition(cwd), createBashToolDefinition(cwd)];
  }
  if (plan.kind === "readonly") {
    const roots = [cwd];
    return [
      confine(createReadToolDefinition(cwd), cwd, roots),
      confine(createGrepToolDefinition(cwd), cwd, roots),
      confine(createFindToolDefinition(cwd), cwd, roots),
      confine(createLsToolDefinition(cwd), cwd, roots),
    ];
  }
  const timeoutMs = (plan.settings.commandTimeoutSeconds ?? 600) * 1000;
  const read = createReadToolDefinition(cwd, {
    operations: {
      // Through the sandbox too, so a symlink the agent planted cannot point outside it.
      async readFile(path) {
        const r = await runInSandbox(plan, scope, ["/bin/cat", "--", path], { timeoutMs: 60_000 });
        if (r.code !== 0) throw new Error(r.stderr.trim() || `Cannot read ${path}`);
        return r.stdout;
      },
      async access(path) {
        const r = await runInSandbox(plan, scope, ["/bin/test", "-r", path], { timeoutMs: 60_000 });
        if (r.code !== 0) throw new Error(`EACCES: cannot read ${path}`);
      },
      detectImageMimeType: async () => null,
    },
  });
  const bash = createBashToolDefinition(cwd, {
    exposeSessionEnvironment: false,
    operations: {
      async exec(command, execCwd, options) {
        const ms = options.timeout ? Math.min(options.timeout * 1000, timeoutMs) : timeoutMs;
        const r = await runInSandbox(plan, scope, ["/bin/bash", "-c", command], {
          cwd: execCwd,
          onData: options.onData,
          timeoutMs: ms,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (r.aborted) throw new Error("aborted");
        // pi's bash tool recognises this message form as a timeout.
        if (r.timedOut) throw new Error(`timeout:${Math.round(ms / 1000)}`);
        return { exitCode: r.code };
      },
    },
  });
  bash.promptGuidelines = [...(bash.promptGuidelines ?? []), ...BASH_GUIDELINES];
  return [read, bash];
}

export function toolNames(plan: SandboxPlan): string[] {
  return plan.kind === "safehouse" ? ["read", "bash"] : plan.kind === "readonly" ? ["read", "grep", "find", "ls"] : ["read", "grep", "find", "ls", "bash"];
}

export function describePlan(plan: SandboxPlan): string {
  switch (plan.kind) {
    case "safehouse":
      return `Sandbox: safehouse (${plan.command}); the agent can run commands`;
    case "readonly":
      return `Sandbox: read-only, no shell${plan.note ? `. ${plan.note}` : ""}`;
    case "none":
      return "Sandbox: none (sandbox.mode is \"none\"); commands run unsandboxed";
  }
}
