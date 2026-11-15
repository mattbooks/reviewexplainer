# reviewexplainer

Guided code review: read a change in the order it makes sense, with explanations beside the code and every comment (AI, GitHub, yours) on the same lines.

It has two parts:

- **The review file** (`*.review.json`): the patch, an ordered guide of reading steps, explanatory notes, and comment threads from an AI pass, GitHub and the local reviewer. One self-contained JSON file; it opens without git or GitHub access.
- **The viewer**: a web app built on [`@pierre/diffs`](https://diffs.com) and [`@pierre/trees`](https://trees.software) that shows the diff step by step, with the guide's narration, threads and a file tree in reading order.

A [pi](https://pi.dev) extension and the `greview` CLI produce and update review files.

## Quick start

Requires Node 22+ and git.

```sh
npm install
npm run build                      # build the viewer once

# In the repository you want to review:
node /path/to/reviewexplainer/packages/cli/bin/greview.mjs init main..my-branch
greview ai                         # optional: pi writes the guide and findings
greview serve                      # opens the viewer on http://127.0.0.1:4173
```

(`npm link -w @reviewexplainer/cli` puts `greview` on your PATH.)

For a pull request: `greview init --pr 482`, then `greview sync github` to pull its review comments.

Try the viewer on the bundled example: `greview serve examples/session-expiry.review.json`.

## Commands

| Command | What it does |
| --- | --- |
| `greview init [base..head] [--pr N] [--with-blobs] [--out FILE] [--ai]` | Collects the diff (merge base to head, like a PR) and writes a review file with a rule-based reading order. Defaults to origin's default branch..HEAD. `--with-blobs` embeds full file contents. `--ai` runs `greview ai` straight after. |
| `greview ai [FILE] [--model provider/id] [--no-findings] [--sandbox MODE]` | Runs a headless pi session in a throwaway checkout of the head commit. The agent reads the change, runs tests to check what it suspects, and writes the reading order, overview, notes and findings through the review tools. Uses pi's default model unless `--model` is given. See [Sandboxing AI reviews](#sandboxing-ai-reviews). |
| `greview sync github [FILE]` | Pulls PR review comments, replies and review summaries into threads. Comments GitHub marks outdated are re-placed by content when possible. |
| `greview push github [FILE] [--no-open]` | Posts your open local threads as a **pending** GitHub review and opens the PR's Files tab, where you submit it. |
| `greview refresh [FILE] [--head REF]` | Re-diffs against the latest head. Keeps steps for unchanged hunks, collects new hunks in "Remaining changes", re-anchors threads by fingerprint and marks the rest outdated. |
| `greview serve [FILE] [--port N] [--no-open]` | Serves the viewer on localhost; comments and viewed state save straight back to the file. |
| `greview validate FILE...` | Checks files against the format rules. |
| `greview watch [--once] [--serve]`, `greview inbox` | Keeps reviews for PRs matching GitHub search filters, each in its own checkout (see [Watching GitHub](#watching-github)). |
| `greview path [FILE]`, `greview schema` | Prints the file greview would use, or the JSON Schema. |

`FILE` defaults to the newest review in the storage folder that matches the current checkout.

GitHub access uses `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`.

## Where review files live

Set `storage` in `.greview.json` (per repository) or `~/.config/greview/config.json`:

| `storage` | Location |
| --- | --- |
| `cache` (default) | `~/.cache/greview/<owner>/<repo>/pr-<n>.review.json` |
| `repo` | `.reviews/pr-<n>.review.json`, to commit and share |
| `path` | A template, e.g. `"path": "artifacts/{repo}-{name}.review.json.gz"` (placeholders `{owner}` `{repo}` `{pr}` `{head}` `{name}`) |

`--out` overrides it for one run. Files ending in `.gz` are gzipped. The same config takes `reviewer` (your name on local comments) and `model` (default for `greview ai`).

## Using it from pi

Load the extension with `pi -e /path/to/reviewexplainer/packages/pi-extension/src/index.ts`, or add the package to pi's settings. Then in pi:

```
/review                  # current branch against the default branch
/review --pr 482
/review main..HEAD --no-findings
/review path/to/pr-482.review.json
```

`/review` creates (or loads) the file and asks the agent to build the guide with these tools:

| Tool | Does |
| --- | --- |
| `review_files` | Lists changed files, roles, hunk ids and the current guide |
| `review_show_hunk` | Shows hunks with row indexes and old/new line numbers |
| `review_set_steps` | Replaces the reading order; rejected unless every hunk is covered exactly once |
| `review_overview` | Sets the overview |
| `review_annotate` | Adds an explanatory note anchored to code |
| `review_comment` | Adds a finding with severity, category and an optional suggested change |
| `review_git_show` | Reads any file at the head or base commit, with line numbers |
| `review_resolve` | Resolves one of the AI's own earlier findings once it is fixed |

Every tool validates against the patch and saves the file, so a bad anchor or a missed hunk comes back to the model as an error it can fix.

Once `/review` starts, the extension's `bash` runs commands in the sandbox (below), with your repository as the working directory and its git config and hooks write-protected. Before `/review`, bash behaves normally. pi's `edit` and `write` tools are not sandboxed in an interactive session, so for code you don't trust, use `greview ai`.

## Sandboxing AI reviews

Every AI review (`greview ai`, `greview init --ai`, `greview watch` and `/review` in pi) lets the agent run the code it reviews: install dependencies, run the tests that cover the change, or write a quick script to confirm a bug. Commands run inside [agent-safehouse](https://agent-safehouse.dev), a macOS Seatbelt sandbox:

```sh
brew install eugene1g/safehouse/agent-safehouse
```

How a run is set up:

- **A throwaway checkout of the head commit.** `greview ai` makes a `git clone --shared` in a temporary folder and deletes it afterwards; `greview watch` keeps one per PR and resets it before every run. Your own working tree is never touched, and tests run against exactly the commit under review.
- **Git the agent can't tamper with.** The checkout's git directory lives outside the working tree and is mounted read-only, and greview always runs git with an explicit `--git-dir`, so the agent can't plant git config or hooks that greview (or you) would later run.
- **Only `read` and `bash`, both inside the sandbox.** The agent can write the checkout and a scratch folder (`TMPDIR`, npm/pip/go caches), and read your toolchains. Each command starts with a clean environment: no API keys, no `GITHUB_TOKEN`, and anything it leaves running in the background is killed when it exits.
- **The model loop stays outside.** pi runs in greview's process, so its credentials (`~/.pi/agent`) are never inside the sandbox. Extensions, skills and `AGENTS.md` from the repository under review are not loaded.

The prompt tells the agent to verify findings by running something when it can, and to say in the comment what it ran and what happened.

Choose the mode in `~/.config/greview/config.json`, or per run with `greview ai --sandbox MODE`:

```json
{
  "sandbox": {
    "mode": "auto",
    "envPass": ["DATABASE_URL"],
    "addDirsRo": ["~/.config/some-tool"],
    "enable": ["docker"],
    "commandTimeoutSeconds": 600
  }
}
```

| `mode` | Agent gets |
| --- | --- |
| `auto` (default) | `safehouse` when it is installed, otherwise `readonly` (greview prints which one it used) |
| `safehouse` | A sandboxed shell. Fails instead of falling back if safehouse is missing. |
| `readonly` | No shell: read, grep, find and ls, confined to the checkout (symlinks included) |
| `none` | pi's normal tools, unsandboxed. Only for code you trust. |

Other settings: `command` (path to safehouse, needed under launchd if it is not on `PATH`, or any wrapper taking the same arguments), `envPass` (variables to pass through from greview's environment), `env` (fixed variables), `addDirs` / `addDirsRo` (extra writable / readable folders), `enable` (safehouse features), `appendProfiles` (your own Seatbelt profiles, applied last), `commandTimeoutSeconds`. Sandbox settings are read only from your user config; a `.greview.json` in a repository cannot change them.

**What it doesn't stop.** safehouse allows network access, so the agent can download dependencies, but a prompt-injected agent could also send out anything it can read: the PR's code and the repository's history (both read-only in the checkout) and whatever toolchain folders safehouse allows. Secrets in the environment, `~/.ssh` and pi's credentials are not readable. Running tests means running the PR author's code, with the same exposure. If that is too much for a repository, use `"mode": "readonly"`.

## The viewer

- **Steps** (default) shows the guide as a route: each stop is a step, filled in as you mark its files viewed. **Files** shows a `@pierre/trees` tree sorted by first appearance in the guide, with open-thread counts.
- Each step's narration sits above its first file. A file split across steps shows only that step's hunks or slices.
- Comment with the `+` in the gutter, or select lines and press `c`. `j`/`k` move between files, `n`/`p` between steps, `v` marks a file viewed and moves on, `x` shows or hides it, `?` lists shortcuts.
- Filter threads by source, show resolved threads, and see outdated threads in their own panel.

It runs in two modes from the same build:

- **Local** (`greview serve`): edits are sent as JSON Patch on `/threads` and `/state`, validated, and written atomically. A changed file on disk is detected with ETags.
- **Hosted**: deploy `packages/viewer/dist` to any static host. Open a file by drag-and-drop, the file picker, or `?src=<url>` (a gist, a raw GitHub file or a CI artifact URL that allows CORS). Nothing is uploaded. Save with Download, or in place where the browser supports the File System Access API.
- **Bundled**: put a `review.json` next to `index.html` in a static deployment and the viewer opens it automatically, which makes a self-contained page to share or attach to CI.

**GitHub Pages.** `.github/workflows/pages.yml` deploys the viewer and the example review on every push to `main`. Turn it on under Settings → Pages → Source: GitHub Actions. A Pages site is public even when the repository is private (and a private repository needs a paid plan for Pages), so the workflow never publishes real reviews: open those from the site with "Open a review file", where they stay in your browser.

On phone-sized screens the steps sit above the code, long lines wrap, and the view stays unified.

## Watching GitHub

`greview watch` keeps a review for every open pull request matching your GitHub search filters, each in its own checkout so the AI can read any file in the repository and run the tests, not just read the diff.

Add filters to `~/.config/greview/config.json`:

```json
{
  "reviewer": "Matt",
  "watch": {
    "filters": [
      { "name": "requested", "query": "is:open review-requested:@me -is:draft" },
      { "name": "team app", "query": "is:open repo:acme/app label:needs-review", "findings": false }
    ],
    "intervalSeconds": 120,
    "settleSeconds": 180,
    "concurrency": 1,
    "retainDays": 7
  }
}
```

Then run `greview watch --serve` and open the inbox it prints (or run `greview inbox` separately).

| Event | What happens |
| --- | --- |
| A PR starts matching a filter | A bare clone per repository (shared object store) gets a checkout at the PR head; the review file is created, GitHub comments are synced, and an AI review is queued. |
| Comments or other activity | GitHub threads are synced into the review file. |
| New commits | After `settleSeconds` without further pushes, the checkout moves to the new head, the review is refreshed (new hunks, re-anchored threads), and the **same AI session** is resumed with a prompt saying the PR was updated and needs a re-review. The agent re-files the new hunks, resolves its own findings that were fixed, and reviews the new code. |
| The PR stops matching but is still open | Paused; the checkout is kept. It resumes if it matches again. |
| The PR is closed or merged | The checkout and its refs are removed at once; the review file and AI session are kept for `retainDays`, then deleted. |
| A PR from a fork | Skipped. |

Other commands: `greview watch --once` (one pass, then exit), `greview watch status`, `greview watch clean` (remove closed and paused reviews and orphaned checkouts now).

Everything lives under `~/.cache/greview/watch/` (`repos/`, `worktrees/` for checkouts, `gitdirs/`, `scratch/`, `sessions/`, `state/`); review files go to `~/.cache/greview/<owner>/<repo>/pr-<n>.review.json`. A restart picks up where it left off: interrupted AI runs are queued again and orphaned checkouts are removed. Failed runs are retried up to three times, ten minutes apart.

**What the agent can do.** Watched PRs contain code and comments written by other people, so the agent runs in the sandbox described in [Sandboxing AI reviews](#sandboxing-ai-reviews): it can run the PR's tests inside safehouse, or only read files if safehouse isn't installed. `greview watch` prints which at startup, and with `"mode": "safehouse"` it refuses to start without it. The checkout is reset before every run, and watch and sandbox settings come only from your user config, never from a repository.

**Running it at login (macOS).** Save as `~/Library/LaunchAgents/dev.greview.watch.plist`, adjust the paths, then `launchctl load ~/Library/LaunchAgents/dev.greview.watch.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.greview.watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/code/reviewexplainer/packages/cli/bin/greview.mjs</string>
    <string>watch</string>
    <string>--serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/greview-watch.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
```

`gh` and `safehouse` must be on that `PATH` (or set `sandbox.command`), `gh` logged in, and git must be able to fetch your private repositories (e.g. `gh auth setup-git`).

## The file format

The schema lives in [`packages/format/src/schema.ts`](packages/format/src/schema.ts) (TypeBox) and is published as [`schema/review.schema.json`](schema/review.schema.json).

| Section | Holds |
| --- | --- |
| `subject` | Repo, base and head SHAs, merge base, optional PR |
| `patch` | The canonical unified diff |
| `files` | Path, old path, status, role and hunks, each with a content-hashed id |
| `guide` | Overview plus ordered steps; each step lists whole hunks (`hunks`) or row ranges of hunks (`slices`) |
| `annotations` | Explanatory notes: explain, never ask for action |
| `threads` | Actionable threads with source (`ai`, `github`, `local`), status, severity and suggestions |
| `state` | Viewed hunks and slices, verdict, hunks new since the last refresh |
| `blobs` | Optional full file contents |

Rules the validator enforces: every hunk is covered exactly once (whole, or by slices that cover all its rows without overlap); `dependsOn` only points at earlier steps; every non-outdated anchor resolves against the patch; ids are unique. Anything a generator could not place goes into a final "Remaining changes" step, so the guide never hides part of the change.

**Anchors.** Hunk ids are `sha1(path + body lines)`, so they survive line shifts. Line anchors store side, range, commit and a fingerprint of the anchored lines, which is how they are re-placed after a new push.

## Development

```sh
npm test             # vitest: format, core, pi extension, CLI, viewer model
npm run typecheck
npm run dev          # viewer dev server; proxies /api to `greview serve --port 4173`
npx tsx examples/make-example.ts   # regenerate the example review
```

| Package | Role |
| --- | --- |
| `packages/format` | Schema, types, patch parser, sub-patches, anchors, validator. No Node or DOM dependencies. |
| `packages/core` | git and GitHub collection, rule-based ordering, sync, push, refresh, storage |
| `packages/pi-extension` | `/review` command, review tools, the sandbox, and the headless agent runner (resumable sessions) |
| `packages/watch` | `greview watch`: filters, checkouts, state, AI queue, cleanup |
| `packages/cli` | `greview`, the local server and the inbox |
| `packages/viewer` | The web app |

The CLI and extension run their TypeScript sources directly (through `tsx` and pi's loader), so only the viewer needs a build.
