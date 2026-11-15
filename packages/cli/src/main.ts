import { parseArgs } from "node:util";
import {
  GitHubClient,
  initReview,
  openInBrowser,
  pushPendingReview,
  readReview,
  refreshFromGit,
  syncGitHub,
  TOOL_VERSION,
  writeReview,
} from "@reviewexplainer/core";
import { ReviewFile as ReviewFileSchema, validateReview } from "@reviewexplainer/format";
import { locateReview, outputPath, repoContext } from "./locate.ts";

const HELP = `greview ${TOOL_VERSION}: guided code reviews

Usage:
  greview init [base..head] [--pr N] [--with-blobs] [--out FILE] [--ai [--model provider/id] [--no-findings]]
      Collect the diff and write a review file with a rule-based reading order.
      Defaults to origin's default branch..HEAD.
  greview ai [FILE] [--model provider/id] [--no-findings]
      Run pi to write the reading order, explanations and AI findings.
  greview sync github [FILE]
      Pull PR review comments and replies into the file.
  greview push github [FILE] [--no-open]
      Post open local threads as a pending GitHub review and open the PR's Files tab.
  greview refresh [FILE] [--head REF]
      Re-diff against the latest head and re-anchor threads.
  greview serve [FILE] [--port N] [--no-open]
      Open the viewer for FILE on localhost, with edits saved back to the file.
  greview validate FILE...
      Check files against the format rules.
  greview path [FILE]
      Print the review file greview would use.
  greview schema
      Print the JSON Schema of the review file.

FILE defaults to the newest review for the current checkout in the configured storage
(.greview.json or ~/.config/greview/config.json; storage: cache | repo | path).
GitHub access uses GITHUB_TOKEN, GH_TOKEN or \`gh auth token\`.
`;

const log = (line: string) => process.stderr.write(`${line}\n`);

function out(line: string) {
  process.stdout.write(`${line}\n`);
}

function bad(message: string): never {
  throw Object.assign(new Error(message), { usage: true });
}

export async function main(argv: string[], env: { cwd?: string } = {}): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      pr: { type: "string" },
      "with-blobs": { type: "boolean" },
      out: { type: "string", short: "o" },
      ai: { type: "boolean" },
      model: { type: "string" },
      "no-findings": { type: "boolean" },
      "no-open": { type: "boolean" },
      port: { type: "string" },
      head: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, ...args] = positionals;
  if (values.version) {
    out(TOOL_VERSION);
    return 0;
  }
  if (!command || values.help || command === "help") {
    out(HELP);
    return 0;
  }
  const cwd = env.cwd ?? process.cwd();

  switch (command) {
    case "init": {
      if (args.length > 1) bad("init takes at most one range, e.g. main..HEAD");
      const pr = values.pr === undefined ? undefined : Number(values.pr);
      if (pr !== undefined && !Number.isInteger(pr)) bad("--pr needs a number");
      if (pr !== undefined && args[0]) bad("Use either --pr or a range, not both");
      const ctx = await repoContext(cwd);
      log(pr !== undefined ? `Fetching PR #${pr}…` : "Collecting the diff…");
      const init: Parameters<typeof initReview>[0] = { cwd, withBlobs: Boolean(values["with-blobs"]) };
      if (args[0]) init.range = args[0];
      if (pr !== undefined) init.pr = pr;
      const { review } = await initReview(init);
      const file = outputPath(ctx, { head: review.subject.head.sha, ...(review.subject.pr ? { pr: review.subject.pr.number } : {}) }, values.out);
      writeReview(file, review);
      const hunks = review.files.reduce((n, f) => n + f.hunks.length, 0);
      log(`Wrote ${review.files.length} files, ${hunks} hunks in ${review.guide.steps.length} steps.`);
      if (values.ai) {
        const { runAi } = await import("./ai.ts");
        await runAi({ file, cwd, findings: !values["no-findings"], log, ...(values.model ? { model: values.model } : {}) });
      }
      out(file);
      return 0;
    }

    case "ai": {
      const file = await locateReview(cwd, args[0]);
      const { runAi } = await import("./ai.ts");
      const ctx = await repoContext(cwd);
      const model = values.model ?? ctx.config.model;
      await runAi({ file, cwd: ctx.root ?? cwd, findings: !values["no-findings"], log, ...(model ? { model } : {}) });
      const review = readReview(file);
      const ai = review.threads.filter((t) => t.source === "ai").length;
      log(`Guide: ${review.guide.steps.length} steps. AI threads: ${ai}. Notes: ${review.annotations.length}.`);
      out(file);
      return 0;
    }

    case "sync":
    case "push": {
      const [target, path] = args;
      if (target !== "github") bad(`Usage: greview ${command} github [FILE]`);
      const file = await locateReview(cwd, path);
      const review = readReview(file);
      const client = await GitHubClient.create();
      if (command === "sync") {
        const result = await syncGitHub(review, client);
        writeReview(file, result.review);
        log(`Synced ${result.total} GitHub threads (${result.added} new).`);
      } else {
        const repo = review.subject.repo;
        if (!repo) bad("This review has no GitHub repository");
        const result = await pushPendingReview(client, repo, review);
        writeReview(file, result.review);
        if (result.pushed === 0) {
          log("No unpushed open local threads.");
        } else {
          log(`Created a pending review with ${result.pushed} threads. Submit it on GitHub:`);
          out(result.url);
          if (!values["no-open"]) await openInBrowser(result.url);
        }
      }
      return 0;
    }

    case "refresh": {
      const file = await locateReview(cwd, args[0]);
      const review = readReview(file);
      const { review: next, report } = await refreshFromGit(review, { cwd, ...(values.head ? { head: values.head } : {}) });
      writeReview(file, next);
      log(
        `Refreshed to ${next.subject.head.sha.slice(0, 12)}: kept ${report.keptHunks} hunks, ${report.newHunks.length} new, ` +
          `${report.relocated.length} anchors moved, ${report.outdated.length} outdated, ${report.droppedSteps.length} steps dropped.`,
      );
      out(file);
      return 0;
    }

    case "validate": {
      if (args.length === 0) args.push(await locateReview(cwd));
      let failed = 0;
      for (const path of args) {
        let result;
        try {
          result = validateReview(readReview(path));
        } catch (e) {
          result = { ok: false, errors: [(e as Error).message], warnings: [] };
        }
        if (result.ok) out(`✓ ${path}`);
        else {
          failed++;
          out(`✗ ${path}`);
          for (const e of result.errors) out(`  - ${e}`);
        }
        for (const w of result.warnings) out(`  ! ${w}`);
      }
      return failed ? 1 : 0;
    }

    case "serve": {
      const file = await locateReview(cwd, args[0]);
      const { createReviewServer, listen } = await import("./serve.ts");
      const ctx = await repoContext(cwd);
      const port = values.port ? Number(values.port) : 4173;
      const server = createReviewServer({ file, port, ...(ctx.config.reviewer ? { reviewer: ctx.config.reviewer } : {}) });
      const actual = await listen(server, port);
      const url = `http://127.0.0.1:${actual}/`;
      log(`Serving ${file}`);
      out(url);
      if (!values["no-open"]) await openInBrowser(url);
      await new Promise(() => {});
      return 0;
    }

    case "path": {
      out(await locateReview(cwd, args[0]));
      return 0;
    }

    case "schema": {
      out(JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", title: "Guided Review file", ...ReviewFileSchema }, null, 2));
      return 0;
    }

    default:
      bad(`Unknown command "${command}". Run greview help.`);
  }
}

export async function run(argv = process.argv.slice(2)): Promise<void> {
  try {
    process.exitCode = await main(argv);
  } catch (e) {
    const err = e as Error & { usage?: boolean; code?: string };
    if (err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || err.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      log(`${err.message}\nRun greview help.`);
    } else {
      log(`greview: ${err.message}`);
    }
    process.exitCode = err.usage ? 2 : 1;
  }
}
