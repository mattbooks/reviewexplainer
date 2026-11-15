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
| `greview ai [FILE] [--model provider/id] [--no-findings]` | Runs a headless pi session that reads the change and writes the reading order, overview, notes and findings through the review tools. Uses pi's default model unless `--model` is given. |
| `greview sync github [FILE]` | Pulls PR review comments, replies and review summaries into threads. Comments GitHub marks outdated are re-placed by content when possible. |
| `greview push github [FILE] [--no-open]` | Posts your open local threads as a **pending** GitHub review and opens the PR's Files tab, where you submit it. |
| `greview refresh [FILE] [--head REF]` | Re-diffs against the latest head. Keeps steps for unchanged hunks, collects new hunks in "Remaining changes", re-anchors threads by fingerprint and marks the rest outdated. |
| `greview serve [FILE] [--port N] [--no-open]` | Serves the viewer on localhost; comments and viewed state save straight back to the file. |
| `greview validate FILE...` | Checks files against the format rules. |
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

Every tool validates against the patch and saves the file, so a bad anchor or a missed hunk comes back to the model as an error it can fix.

## The viewer

- **Steps** (default) shows the guide as a route: each stop is a step, filled in as you mark its files viewed. **Files** shows a `@pierre/trees` tree sorted by first appearance in the guide, with open-thread counts.
- Each step's narration sits above its first file. A file split across steps shows only that step's hunks or slices.
- Comment with the `+` in the gutter, or select lines and press `c`. `j`/`k` move between files, `n`/`p` between steps, `v` marks a file viewed and moves on, `x` shows or hides it, `?` lists shortcuts.
- Filter threads by source, show resolved threads, and see outdated threads in their own panel.

It runs in two modes from the same build:

- **Local** (`greview serve`): edits are sent as JSON Patch on `/threads` and `/state`, validated, and written atomically. A changed file on disk is detected with ETags.
- **Hosted**: deploy `packages/viewer/dist` to any static host. Open a file by drag-and-drop, the file picker, or `?src=<url>` (a gist, a raw GitHub file or a CI artifact URL that allows CORS). Nothing is uploaded. Save with Download, or in place where the browser supports the File System Access API.
- **Bundled**: put a `review.json` next to `index.html` in a static deployment and the viewer opens it automatically, which makes a self-contained page to share or attach to CI.

On phone-sized screens the steps sit above the code, long lines wrap, and the view stays unified.

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
| `packages/pi-extension` | `/review` command and review tools |
| `packages/cli` | `greview` |
| `packages/viewer` | The web app |

The CLI and extension run their TypeScript sources directly (through `tsx` and pi's loader), so only the viewer needs a build.
