/**
 * pi extension: `/review` command plus review_* tools.
 *
 * Load it in pi with `pi -e <path>/packages/pi-extension/src/index.ts`, by
 * listing this package in pi's settings, or from the SDK through
 * `createReviewExtension({ file })` (that is what `greview ai` does).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initReview, loadConfig, readReview, reviewPath, writeReview } from "@reviewexplainer/core";
import type { ReviewFile } from "@reviewexplainer/format";
import { reviewPrompt } from "./prompt.ts";
import { ALL_TOOLS, type ReviewSession } from "./tools.ts";

export { reviewPrompt } from "./prompt.ts";
export * from "./tools.ts";

export interface ReviewExtensionOptions {
  /** Review file to work on. Otherwise from --review, $GREVIEW_FILE, or `/review`. */
  file?: string;
  /** Called after every successful save. */
  onSave?: (review: ReviewFile) => void;
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
    let current: ReviewFile | undefined;
    let modelInfo: { model: string; provider: string } | undefined;

    const currentFile = (): string => {
      const flag = pi.getFlag("review");
      const chosen = file ?? (typeof flag === "string" && flag ? flag : undefined) ?? process.env.GREVIEW_FILE;
      if (!chosen) throw new Error("No review loaded. Run /review first (or start pi with --review <file>).");
      file = resolve(chosen);
      return file;
    };

    const session: ReviewSession = {
      get() {
        const path = currentFile();
        if (!current) current = readReview(path);
        return current;
      },
      save(next) {
        writeReview(currentFile(), next);
        current = next;
        opts.onSave?.(next);
      },
      ai: () => modelInfo,
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
          return (tool.run as (s: ReviewSession, p: unknown) => ReturnType<typeof tool.run>)(session, params);
        },
      });
    }

    pi.registerCommand("review", {
      description: "Build a guided review: /review [base..head | --pr N | file.review.json] [--no-findings]",
      handler: async (args, ctx) => {
        const parsed = parseReviewArgs(args);
        if (parsed.file) {
          const path = resolve(ctx.cwd, parsed.file);
          if (!existsSync(path)) throw new Error(`${path} does not exist`);
          file = path;
          current = readReview(path);
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
          current = review;
        }
        if (ctx.hasUI) ctx.ui.notify(`Review file: ${file}`, "info");
        pi.sendUserMessage(reviewPrompt(current, { findings: parsed.findings }));
      },
    });
  };
}

export default createReviewExtension();
