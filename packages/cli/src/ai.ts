/**
 * `greview ai`: run a headless pi session with the review extension loaded.
 * Uses pi's configured default model unless --model provider/id is given.
 */
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
import { ALL_TOOLS, createReviewExtension, reviewPrompt } from "@reviewexplainer/pi-extension";

export interface AiOptions {
  file: string;
  cwd: string;
  model?: string;
  findings: boolean;
  log: (line: string) => void;
  /** Extra session options (tests inject a scripted model here). */
  sessionOverrides?: Partial<CreateAgentSessionOptions>;
}

export async function runAi(opts: AiOptions): Promise<{ model?: string }> {
  const review = readReview(opts.file);
  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    extensionFactories: [createReviewExtension({ file: opts.file })],
  });
  await resourceLoader.reload();

  const sessionOptions: CreateAgentSessionOptions = {
    cwd: opts.cwd,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    // Read-only exploration plus the review tools: the agent must not edit the repo.
    tools: ["read", "grep", "find", "ls", "bash", ...ALL_TOOLS.map((t) => t.name)],
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
  opts.log(`Model: ${used}`);
  let lastWasText = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      if (lastWasText) opts.log("");
      opts.log(`→ ${event.toolName}`);
      lastWasText = false;
    } else if (event.type === "tool_execution_end" && event.isError) {
      opts.log(`  ✗ ${event.toolName} failed; the model will retry`);
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stderr.write(event.assistantMessageEvent.delta);
      lastWasText = true;
    }
  });
  try {
    await session.prompt(reviewPrompt(review, { findings: opts.findings }));
  } finally {
    unsubscribe();
    session.dispose();
  }
  if (lastWasText) opts.log("");
  const after = readReview(opts.file);
  writeReview(opts.file, recordGenerator(after, `${TOOL_NAME} ai`, TOOL_VERSION, used));
  return { model: used };
}
