import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readReview } from "@reviewexplainer/core";
import { parsePatch, pointer, validateReview, type Thread } from "@reviewexplainer/format";
import { makeRepo } from "../../core/test/helpers.ts";
import { runAi } from "../src/ai.ts";
import { main } from "../src/main.ts";
import { createReviewServer, listen } from "../src/serve.ts";

const cleanups: (() => void)[] = [];
let home: string;
let stdout: string[];
const realWrite = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "greview-home-"));
  process.env.XDG_CACHE_HOME = join(home, "cache");
  process.env.XDG_CONFIG_HOME = join(home, "config");
  process.env.PI_CODING_AGENT_DIR = join(home, "pi");
  delete process.env.GREVIEW_FILE;
  stdout = [];
  process.stdout.write = ((chunk: string) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});
afterEach(() => {
  process.stdout.write = realWrite;
  process.stderr.write = realErr;
  while (cleanups.length) cleanups.pop()!();
  rmSync(home, { recursive: true, force: true });
});

function repo() {
  const r = makeRepo();
  cleanups.push(r.cleanup);
  return r.root;
}

const lastLine = () => stdout.join("").trim().split("\n").at(-1)!;

describe("greview init / validate / path", () => {
  it("writes a valid review to the cache and finds it again", async () => {
    const root = repo();
    expect(await main(["init", "main..feature"], { cwd: root })).toBe(0);
    const file = lastLine();
    expect(file).toBe(join(home, "cache", "greview", "local", "repo", `${readReview(file).subject.head.sha.slice(0, 12)}.review.json`));
    expect(validateReview(readReview(file)).ok).toBe(true);

    stdout = [];
    expect(await main(["path"], { cwd: root })).toBe(0);
    expect(lastLine()).toBe(file);

    stdout = [];
    expect(await main(["validate"], { cwd: root })).toBe(0);
    expect(stdout.join("")).toContain(`✓ ${file}`);
  });

  it("honours repo storage and --out", async () => {
    const root = repo();
    writeFileSync(join(root, ".greview.json"), JSON.stringify({ storage: "repo" }));
    await main(["init", "main..feature"], { cwd: root });
    expect(lastLine().startsWith(join(root, ".reviews"))).toBe(true);
    const out = join(home, "x.review.json.gz");
    await main(["init", "main..feature", "--out", out], { cwd: root });
    expect(lastLine()).toBe(out);
    expect(readReview(out).files.length).toBe(8);
  });

  it("fails validation with readable errors", async () => {
    const bad = join(home, "bad.review.json");
    writeFileSync(bad, JSON.stringify({ version: 1 }));
    expect(await main(["validate", bad], { cwd: home })).toBe(1);
    expect(stdout.join("")).toContain("✗");
  });

  it("prints the JSON schema", async () => {
    await main(["schema"], { cwd: home });
    const schema = JSON.parse(stdout.join(""));
    expect(schema.properties.guide.properties.steps.type).toBe("array");
  });
});

describe("greview ai with a scripted model", () => {
  it("drives the review tools through a real pi session", async () => {
    const root = repo();
    await main(["init", "main..feature"], { cwd: root });
    const file = lastLine();
    const review = readReview(file);
    const steps = [
      {
        id: "model",
        title: "Users gain an email",
        kind: "context",
        narrative: "The User type gets an optional email.",
        items: [{ path: "src/types.ts", hunks: "all" }],
      },
      {
        id: "rest",
        title: "Greeting and callers",
        kind: "core",
        narrative: "Everything that uses the new field.",
        dependsOn: ["model"],
        items: review.files.filter((f) => f.path !== "src/types.ts").map((f) => ({ path: f.path, hunks: "all" })),
      },
    ];
    const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted" }] });
    const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("review_files", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("review_set_steps", JSON.parse(JSON.stringify({ steps })))], { stopReason: "toolUse" }),
      fauxAssistantMessage(
        [
          fauxToolCall("review_overview", { summary: "Adds an optional email to users and shows it in greetings." }),
          fauxToolCall("review_comment", { path: "src/service.ts", start: 4, body: "Email is shown unescaped.", severity: "minor" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Two steps; one minor finding.")]),
    ]);
    const lines: string[] = [];
    const result = await runAi({
      file,
      cwd: root,
      findings: true,
      log: (l) => lines.push(l),
      sessionOverrides: { modelRuntime: runtime, model: faux.getModel() },
    });
    expect(result.model).toBe("faux/scripted");
    expect(lines).toEqual(expect.arrayContaining(["→ review_files", "→ review_set_steps", "→ review_comment"]));
    const after = readReview(file);
    expect(after.guide).toMatchObject({ generatedBy: "ai", overview: expect.stringContaining("optional email") });
    expect(after.guide.steps.map((s) => s.id)).toEqual(["model", "rest"]);
    expect(after.threads[0]).toMatchObject({ source: "ai", severity: "minor", comments: [{ ai: { provider: "faux", model: "scripted" } }] });
    expect(after.generators.at(-1)).toMatchObject({ tool: "greview ai", model: "faux/scripted" });
    expect(validateReview(after).errors).toEqual([]);
  });
});

describe("greview serve", () => {
  async function serve() {
    const root = repo();
    await main(["init", "main..feature"], { cwd: root });
    const file = lastLine();
    const viewerDir = join(home, "viewer");
    mkdirSync(join(viewerDir, "assets"), { recursive: true });
    writeFileSync(join(viewerDir, "index.html"), "<!doctype html><title>viewer</title>");
    writeFileSync(join(viewerDir, "assets", "app.js"), "console.log(1)");
    writeFileSync(join(home, "secret.txt"), "nope");
    const server = createReviewServer({ file, port: 0, viewerDir, reviewer: "Matt" });
    await listen(server, 0);
    cleanups.push(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { file, base };
  }

  it("serves the viewer and the review", async () => {
    const { base, file } = await serve();
    expect(await (await fetch(`${base}/`)).text()).toContain("<title>viewer</title>");
    expect((await fetch(`${base}/assets/app.js`)).headers.get("content-type")).toContain("javascript");
    expect(await (await fetch(`${base}/..%2fsecret.txt`)).text()).not.toContain("nope");
    expect(await (await fetch(`${base}/api/info`)).json()).toEqual({ mode: "local", file, reviewer: "Matt" });
    const res = await fetch(`${base}/api/review`);
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{16}"$/);
    expect(((await res.json()) as { version: number }).version).toBe(1);
  });

  it("applies validated JSON Patch edits to threads and state only", async () => {
    const { base, file } = await serve();
    const review = readReview(file);
    const etag = (await fetch(`${base}/api/review`)).headers.get("etag")!;
    const model = parsePatch(review.patch);
    const hunk = model.byPath.get("src/types.ts")!.hunks[0]!;
    const thread: Thread = {
      id: "local_1",
      source: "local",
      status: "open",
      anchor: { kind: "hunk", path: "src/types.ts", hunk: hunk.id },
      comments: [{ id: "c1", author: { name: "Matt", kind: "human" }, body: "Why optional?", createdAt: "2026-11-15T00:00:00Z" }],
    };
    const ok = await fetch(`${base}/api/review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify([
        { op: "add", path: "/threads/-", value: thread },
        { op: "add", path: pointer("state", "viewed", hunk.id), value: { at: "2026-11-15T00:00:00Z" } },
      ]),
    });
    expect(ok.status).toBe(200);
    const saved = readReview(file);
    expect(saved.threads.map((t) => t.id)).toEqual(["local_1"]);
    expect(saved.state.viewed[hunk.id]).toBeDefined();

    const stale = await fetch(`${base}/api/review`, { method: "PATCH", headers: { "If-Match": etag }, body: "[]" });
    expect(stale.status).toBe(409);
    const forbidden = await fetch(`${base}/api/review`, {
      method: "PATCH",
      body: JSON.stringify([{ op: "replace", path: "/patch", value: "" }]),
    });
    expect(forbidden.status).toBe(400);
    const invalid = await fetch(`${base}/api/review`, {
      method: "PATCH",
      body: JSON.stringify([{ op: "add", path: "/threads/-", value: { ...thread, id: "local_2", anchor: { kind: "file", path: "nope.ts" } } }]),
    });
    expect(invalid.status).toBe(422);
    const crossSite = await fetch(`${base}/api/review`, { headers: { Origin: "https://evil.example" } });
    expect(crossSite.status).toBe(403);
    expect(readFileSync(file, "utf8")).toContain("Why optional?");
  });
});
