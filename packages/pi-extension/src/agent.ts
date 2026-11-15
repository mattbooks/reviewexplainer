/**
 * Runs a headless pi session with the review extension loaded. Used by
 * `greview ai` and `greview watch`.
 *
 * The agent always works in a disposable checkout of the head commit (see
 * core/checkout.ts), with its tools sandboxed as configured (see sandbox.ts).
 * The model loop runs here, outside the sandbox, so pi's credentials never
 * enter it.
 *
 * Sessions can be persisted: pass `sessionDir` to create a session file, and
 * `sessionFile` later to continue the same conversation (e.g. a re-review
 * after new commits), so the agent keeps what it learned on the first pass.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { prepareCheckout, readReview, writeReview, TOOL_NAME, TOOL_VERSION, type Checkout } from "@reviewexplainer/core";
import { recordGenerator } from "@reviewexplainer/format";
import { createReviewExtension } from "./index.ts";
import { reviewPrompt } from "./prompt.ts";
import { ALL_TOOLS } from "./tools.ts";
import { describePlan, loadSandboxSettings, resolveSandbox, sandboxTools, toolNames, type SandboxPlan, type SandboxSettings } from "./sandbox.ts";

export interface AiOptions {
  file: string;
  /** A repository that has the head commit (used to make the checkout). */
  cwd: string;
  /** provider/model-id; default: pi's configured default model (or the resumed session's). */
  model?: string;
  findings: boolean;
  log: (line: string) => void;
  /** Prompt to send; default: the full first-pass review prompt. */
  prompt?: string;
  /** Sandbox settings; default: `sandbox` from the user config. */
  sandbox?: SandboxSettings;
  /** Resolved sandbox (overrides `sandbox`; tests use it). */
  sandboxPlan?: SandboxPlan;
  /**
   * Checkout to work in, kept by the caller (`greview watch` keeps one per PR).
   * Default: a temporary checkout of the head commit, removed afterwards.
   */
  checkout?: Checkout;
  /** Continue this session file. */
  sessionFile?: string;
  /** Persist a new session in this directory (ignored when sessionFile exists). */
  sessionDir?: string;
  /** Write assistant text to stderr as it streams (CLI). */
  stream?: boolean;
  /** Extra session options (tests inject a scripted model here). */
  sessionOverrides?: Partial<CreateAgentSessionOptions>;
}

export interface AiResult {
  model?: string;
  sandbox: SandboxPlan["kind"];
  sessionFile?: string;
  /** The assistant's final text. */
  summary: string;
}

export async function runAi(opts: AiOptions): Promise<AiResult> {
  const review = readReview(opts.file);
  const plan = opts.sandboxPlan ?? resolveSandbox(opts.sandbox ?? loadSandboxSettings());
  let checkout = opts.checkout;
  let temp: string | undefined;
  if (!checkout) {
    temp = mkdtempSync(join(tmpdir(), "greview-ai-"));
    try {
      checkout = await prepareCheckout(opts.cwd, review.subject.head.sha, {
        dir: join(temp, "work"),
        gitDir: join(temp, "git"),
        scratch: join(temp, "scratch"),
      });
    } catch (e) {
      rmSync(temp, { recursive: true, force: true });
      throw new Error(
        `Could not check out the head commit ${review.subject.head.sha.slice(0, 12)} from ${opts.cwd}: ${(e as Error).message}. Fetch it first (for a PR: git fetch origin pull/<n>/head).`,
      );
    }
  }
  try {
    return await runInCheckout(opts, review, plan, checkout);
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function runInCheckout(opts: AiOptions, review: ReturnType<typeof readReview>, plan: SandboxPlan, checkout: Checkout): Promise<AiResult> {
  const cwd = checkout.dir;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    // Your own extensions (e.g. a model provider) load as usual, but nothing
    // from the repository under review: its extensions, skills, prompt
    // templates and AGENTS.md are code or instructions from the PR author.
    extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((e) => !isInside(cwd, e.resolvedPath)) }),
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [createReviewExtension({ file: opts.file, git: checkout.git, sandboxBash: false })],
  });
  await resourceLoader.reload();

  const resume = opts.sessionFile && existsSync(opts.sessionFile);
  const sessionManager = resume
    ? SessionManager.open(opts.sessionFile!, undefined, cwd)
    : opts.sessionDir
      ? SessionManager.create(cwd, opts.sessionDir)
      : SessionManager.inMemory(cwd);

  const reviewTools = ALL_TOOLS.map((t) => t.name);
  const sessionOptions: CreateAgentSessionOptions = {
    cwd,
    resourceLoader,
    sessionManager,
    // Exploration (sandboxed as configured) plus the review tools; never edit or write.
    tools: [...toolNames(plan), ...reviewTools],
    customTools: sandboxTools(plan, { workdir: cwd, scratch: checkout.scratch, readOnlyDirs: checkout.readOnlyDirs }),
  };
  if (opts.model) {
    const [provider, ...rest] = opts.model.split("/");
    const id = rest.join("/");
    if (!provider || !id) throw new Error("--model must look like provider/model-id, e.g. anthropic/claude-sonnet-4-5");
    const runtime = await ModelRuntime.create();
    const model = runtime.getModel(provider, id);
    if (!model) throw new Error(`Unknown model ${opts.model}. List models with \`pi --list-models\`.`);
    sessionOptions.modelRuntime = runtime;
    sessionOptions.model = model;
  }

  Object.assign(sessionOptions, opts.sessionOverrides);
  const { session } = await createAgentSession(sessionOptions);
  const used = session.model ? `${session.model.provider}/${session.model.id}` : undefined;
  if (!used) {
    session.dispose();
    throw new Error("pi has no model configured. Run `pi` once to log in, or pass --model provider/id.");
  }
  opts.log(`Model: ${used}${resume ? " (continuing the earlier session)" : ""}`);
  opts.log(describePlan(plan));
  let lastWasText = false;
  let summary = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      if (lastWasText && opts.stream) opts.log("");
      const command = event.toolName === "bash" ? (event.args as { command?: string } | undefined)?.command : undefined;
      opts.log(`→ ${event.toolName}${command ? `: ${command.split("\n")[0]!.slice(0, 120)}` : ""}`);
      lastWasText = false;
      summary = "";
    } else if (event.type === "tool_execution_end" && event.isError) {
      opts.log(`  ✗ ${event.toolName} failed; the model will retry`);
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (opts.stream) process.stderr.write(event.assistantMessageEvent.delta);
      summary += event.assistantMessageEvent.delta;
      lastWasText = true;
    }
  });
  try {
    await session.prompt(opts.prompt ?? reviewPrompt(review, { findings: opts.findings, tools: plan.kind === "readonly" ? "readonly" : "shell", checkout: true }));
    // pi reports a failed turn (provider error, abort) in the transcript rather than by throwing.
    const last = [...session.messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
      | { stopReason?: string; errorMessage?: string }
      | undefined;
    if (last && (last.stopReason === "error" || last.stopReason === "aborted")) {
      throw new Error(`The model run ${last.stopReason === "aborted" ? "was aborted" : "failed"}${last.errorMessage ? `: ${last.errorMessage}` : ""}`);
    }
  } finally {
    unsubscribe();
    session.dispose();
  }
  if (lastWasText && opts.stream) opts.log("");
  const after = readReview(opts.file);
  writeReview(opts.file, recordGenerator(after, `${TOOL_NAME} ai`, TOOL_VERSION, used));
  const sessionFile = sessionManager.getSessionFile();
  return { model: used, sandbox: plan.kind, summary: summary.trim(), ...(sessionFile ? { sessionFile } : {}) };
}
