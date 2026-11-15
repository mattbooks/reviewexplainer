/**
 * pi extension: `/review` command plus review_* tools.
 *
 * Load it in pi with `pi -e <path>/packages/pi-extension/src/index.ts`, by
 * listing this package in pi's settings, or from the SDK through
 * `createReviewExtension({ file })` (that is what `greview ai` does).
 */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cacheDir, git, initReview, loadConfig, readReview, reviewPath, writeReview } from "@reviewexplainer/core";
import type { ReviewFile } from "@reviewexplainer/format";
import { reviewPrompt } from "./prompt.ts";
import { ALL_TOOLS, type ReviewSession } from "./tools.ts";
import { loadSandboxSettings, protectGitDirProfile, resolveSandbox, sandboxTools, type SandboxPlan, type SandboxScope } from "./sandbox.ts";

export { reviewPrompt, rereviewPrompt } from "./prompt.ts";
export * from "./tools.ts";
export * from "./sandbox.ts";
export { runAi, type AiOptions, type AiResult } from "./agent.ts";

export interface ReviewExtensionOptions {
  /** Review file to work on. Otherwise from --review, $GREVIEW_FILE, or `/review`. */
  file?: string;
  /** Called after every successful save. */
  onSave?: (review: ReviewFile) => void;
  /** Git runner for the review tools (checkouts pass one that ignores the agent-writable `.git`). */
  git?: (...args: string[]) => Promise<string>;
  /**
   * In interactive pi, replace bash so that once /review starts, commands run
   * in the configured sandbox (default true). `greview ai` sets its own tools.
   */
  sandboxBash?: boolean;
  /** Sandbox to use instead of the user config (tests). */
  sandboxPlan?: SandboxPlan;
}

export interface ReviewCommandArgs {
  file?: string;
  range?: string;
  pr?: number;
  findings: boolean;
}

export function parseReviewArgs(args: string): ReviewCommandArgs {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const out: ReviewCommandArgs = { findings: true };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "--pr") out.pr = Number(parts[++i]);
    else if (p.startsWith("--pr=")) out.pr = Number(p.slice(5));
    else if (p === "--no-findings") out.findings = false;
    else if (/\.review\.json(\.gz)?$/.test(p)) out.file = p;
    else out.range = p;
  }
  if (out.pr !== undefined && !Number.isInteger(out.pr)) throw new Error("--pr needs a number");
  return out;
}

export function createReviewExtension(opts: ReviewExtensionOptions = {}) {
  return function reviewExtension(pi: ExtensionAPI): void {
    let file = opts.file;
    let modelInfo: { model: string; provider: string } | undefined;
    let cwd = process.cwd();

    const currentFile = (): string => {
      const flag = pi.getFlag("review");
      const chosen = file ?? (typeof flag === "string" && flag ? flag : undefined) ?? process.env.GREVIEW_FILE;
      if (!chosen) throw new Error("No review loaded. Run /review first (or start pi with --review <file>).");
      file = resolve(chosen);
      return file;
    };

    // Always read from disk: the viewer and `greview watch` write the same file
    // while an agent works, and a cached copy would overwrite their edits.
    const session: ReviewSession = {
      get: () => readReview(currentFile()),
      save(next) {
        writeReview(currentFile(), next);
        opts.onSave?.(next);
      },
      ai: () => modelInfo,
      cwd: () => cwd,
      ...(opts.git ? { git: opts.git } : {}),
    };

    pi.registerFlag("review", { type: "string", description: "Review file for the review_* tools" });

    for (const tool of ALL_TOOLS) {
      pi.registerTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        promptSnippet: tool.promptSnippet,
        parameters: tool.parameters,
        async execute(_id, params, _signal, _onUpdate, ctx) {
          modelInfo = ctx.model ? { model: ctx.model.id, provider: String(ctx.model.provider) } : undefined;
          cwd = ctx.cwd;
          return await (tool.run as (s: ReviewSession, p: unknown) => ReturnType<typeof tool.run>)(session, params);
        },
      });
    }

    // Interactive pi: bash behaves normally until /review starts; from then on
    // it runs in the sandbox (or is refused when only read-only is possible).
    let reviewing = false;
    let plan: SandboxPlan | undefined;
    let planError: string | undefined;
    if (opts.sandboxBash !== false) {
      try {
        plan = opts.sandboxPlan ?? resolveSandbox(loadSandboxSettings());
      } catch (e) {
        planError = (e as Error).message;
      }
      if (planError || plan?.kind !== "none") {
        const base = createBashToolDefinition(process.cwd());
        pi.registerTool({
          ...base,
          async execute(id, params, signal, onUpdate, ctx) {
            if (!reviewing) return createBashToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
            if (planError) throw new Error(planError);
            if (plan!.kind === "readonly") {
              throw new Error(`bash is off during /review: ${plan!.note ?? "the sandbox is read-only"}. Use read, grep, find and ls.`);
            }
            const scope = await interactiveScope(ctx.cwd);
            const sandboxed = sandboxTools(plan!, scope).find((t) => t.name === "bash")!;
            return sandboxed.execute(id, params, signal, onUpdate, ctx);
          },
        });
      }
    }

    pi.registerCommand("review", {
      description: "Build a guided review: /review [base..head | --pr N | file.review.json] [--no-findings]",
      handler: async (args, ctx) => {
        const parsed = parseReviewArgs(args);
        if (parsed.file) {
          const path = resolve(ctx.cwd, parsed.file);
          if (!existsSync(path)) throw new Error(`${path} does not exist`);
          file = path;
        } else {
          const init: Parameters<typeof initReview>[0] = { cwd: ctx.cwd };
          if (parsed.range) init.range = parsed.range;
          if (parsed.pr !== undefined) init.pr = parsed.pr;
          const { review, root, repo } = await initReview(init);
          const key = {
            head: review.subject.head.sha,
            ...(repo ? { owner: repo.owner, repo: repo.name } : {}),
            ...(review.subject.pr ? { pr: review.subject.pr.number } : {}),
          };
          const path = reviewPath(loadConfig(root), key, root);
          writeReview(path, review);
          file = path;
        }
        reviewing = opts.sandboxBash !== false;
        const shell = !planError && plan?.kind !== "readonly";
        if (ctx.hasUI) {
          ctx.ui.notify(`Review file: ${file}`, "info");
          if (reviewing) {
            ctx.ui.notify(
              planError ? `bash is off: ${planError}` : plan!.kind === "safehouse" ? "bash runs in safehouse for this review" : plan!.kind === "readonly" ? `bash is off for this review. ${plan!.note ?? ""}` : "bash is not sandboxed (sandbox.mode is none)",
              plan?.kind === "safehouse" ? "info" : "warning",
            );
          }
        }
        pi.sendUserMessage(
          reviewPrompt(readReview(file), { findings: parsed.findings, tools: shell ? "shell" : "readonly", sandboxed: plan?.kind === "safehouse" }),
        );
      },
    });
  };
}

/**
 * Sandbox scope for interactive pi: the user's own repository is the workdir,
 * so its git config and hooks are protected by an extra Seatbelt rule.
 */
async function interactiveScope(cwd: string): Promise<SandboxScope> {
  const scratch = join(cacheDir(), "sandbox", createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 12));
  const scope: SandboxScope = { workdir: cwd, scratch, readOnlyDirs: [] };
  try {
    const gitDir = (await git(cwd, "rev-parse", "--absolute-git-dir")).trim();
    const common = resolve(cwd, (await git(cwd, "rev-parse", "--git-common-dir")).trim());
    scope.profile = [...new Set([gitDir, common])].filter((d) => statSync(d).isDirectory()).map(protectGitDirProfile).join("");
  } catch {
    // not a git repository: nothing to protect
  }
  return scope;
}

export default createReviewExtension();
