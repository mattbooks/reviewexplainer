/**
 * Runs a headless pi session with the review extension loaded. Used by
 * `greview ai` and `greview watch`.
 *
 * Sessions can be persisted: pass `sessionDir` to create a session file, and
 * `sessionFile` later to continue the same conversation (e.g. a re-review
 * after new commits), so the agent keeps what it learned on the first pass.
 */
import { existsSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { readReview, writeReview, TOOL_NAME, TOOL_VERSION } from "@reviewexplainer/core";
import { recordGenerator } from "@reviewexplainer/format";
import { createReviewExtension } from "./index.ts";
import { reviewPrompt } from "./prompt.ts";
import { ALL_TOOLS } from "./tools.ts";

export interface AiOptions {
  file: string;
  cwd: string;
  /** provider/model-id; default: pi's configured default model (or the resumed session's). */
  model?: string;
  findings: boolean;
  log: (line: string) => void;
  /** Prompt to send; default: the full first-pass review prompt. */
  prompt?: string;
  /**
   * No bash: only read, grep, find, ls and the review tools. For untrusted
   * code (`greview watch`), where the working directory is a disposable worktree.
   */
  readOnly?: boolean;
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
  sessionFile?: string;
  /** The assistant's final text. */
  summary: string;
}

export async function runAi(opts: AiOptions): Promise<AiResult> {
  const review = readReview(opts.file);
  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    extensionFactories: [createReviewExtension({ file: opts.file })],
  });
  await resourceLoader.reload();

  const resume = opts.sessionFile && existsSync(opts.sessionFile);
  const sessionManager = resume
    ? SessionManager.open(opts.sessionFile!, undefined, opts.cwd)
    : opts.sessionDir
      ? SessionManager.create(opts.cwd, opts.sessionDir)
      : SessionManager.inMemory(opts.cwd);

  const reviewTools = ALL_TOOLS.map((t) => t.name);
  const sessionOptions: CreateAgentSessionOptions = {
    cwd: opts.cwd,
    resourceLoader,
    sessionManager,
    // Exploration plus the review tools: the agent must never edit the repo.
    tools: opts.readOnly ? ["read", "grep", "find", "ls", ...reviewTools] : ["read", "grep", "find", "ls", "bash", ...reviewTools],
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
  let lastWasText = false;
  let summary = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      if (lastWasText && opts.stream) opts.log("");
      opts.log(`→ ${event.toolName}`);
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
    await session.prompt(opts.prompt ?? reviewPrompt(review, { findings: opts.findings, worktree: Boolean(opts.readOnly) }));
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
  return { model: used, summary: summary.trim(), ...(sessionFile ? { sessionFile } : {}) };
}
