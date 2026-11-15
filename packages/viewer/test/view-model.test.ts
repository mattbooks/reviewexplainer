import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePatch, type ReviewFile } from "@reviewexplainer/format";
import { apply, opsFor } from "../src/store.ts";
import { buildLayout, decorate, DEFAULT_FILTERS, isViewed, mechanicalItems, placeAnchor, stepProgress } from "../src/view-model.ts";

const review = JSON.parse(
  readFileSync(new URL("../../../examples/session-expiry.review.json", import.meta.url), "utf8"),
) as ReviewFile;

describe("view model", () => {
  const layout = buildLayout(review);

  it("makes one item per step and file, in guide order", () => {
    expect(layout.infos.map((i) => i.id)).toEqual([
      "session-shape::src/session/types.ts",
      "manager::src/session/manager.ts",
      "http::src/http/login.ts",
      "http::src/http/auth-middleware.ts",
      "tests-docs::test/session.test.ts",
      "tests-docs::docs/sessions.md",
      "lockfile::package-lock.json",
    ]);
    for (const info of layout.infos) expect(info.fileDiff.hunks.length).toBeGreaterThan(0);
  });

  it("places line threads on the item that shows the line", () => {
    const thread = review.threads.find((t) => t.severity === "blocker")!;
    expect(placeAnchor(layout, thread.anchor)).toMatchObject({ kind: "item", itemId: "manager::src/session/manager.ts", side: "new" });
    expect(placeAnchor(layout, { kind: "review" })).toEqual({ kind: "review" });
    expect(placeAnchor(layout, { kind: "file", path: "docs/sessions.md" })).toMatchObject({ itemId: "tests-docs::docs/sessions.md", line: 0 });
  });

  it("decorates items with narration, threads and filters", () => {
    const d = decorate(review, layout, { filters: DEFAULT_FILTERS, expanded: new Set(), collapsedByDefault: mechanicalItems(review, layout) });
    const manager = d.items.find((i) => i.id === "manager::src/session/manager.ts")!;
    const narration = manager.annotations!.find((a) => a.metadata.narrativeStep === "manager");
    expect(narration?.lineNumber).toBe(0);
    expect(manager.annotations!.flatMap((a) => a.metadata.threadIds)).toHaveLength(2);
    expect(manager.annotations!.flatMap((a) => a.metadata.noteIds)).toHaveLength(1);
    expect(d.openByPath.get("src/session/manager.ts")).toBe(2);
    expect(d.items.find((i) => i.id === "lockfile::package-lock.json")!.collapsed).toBe(true);

    const noAi = decorate(review, layout, {
      filters: { ...DEFAULT_FILTERS, sources: { ai: false, github: true, local: true } },
      expanded: new Set(),
      collapsedByDefault: new Set(),
    });
    expect(noAi.openByPath.get("src/session/manager.ts")).toBeUndefined();
    expect(noAi.items.find((i) => i.id === manager.id)!.version).not.toBe(manager.version);
  });

  it("tracks viewed state per item and per step", () => {
    const info = layout.byId.get("http::src/http/login.ts")!;
    const after = apply(review, opsFor(review, { type: "viewed", keys: info.viewKeys, viewed: true }));
    expect(isViewed(after, info)).toBe(true);
    expect(stepProgress(after, layout, "http")).toEqual({ viewed: 1, total: 2 });
    const undone = apply(after, opsFor(after, { type: "viewed", keys: info.viewKeys, viewed: false }));
    expect(isViewed(undone, info)).toBe(false);
  });

  it("builds comment, reply and status edits as JSON Patch", () => {
    const model = parsePatch(review.patch);
    expect(model.files.length).toBe(7);
    let next = apply(review, opsFor(review, { type: "comment", anchor: { kind: "review" }, body: "Hi", author: "Matt" }));
    const added = next.threads.at(-1)!;
    expect(added).toMatchObject({ source: "local", status: "open", comments: [{ body: "Hi", author: { name: "Matt" } }] });
    next = apply(next, opsFor(next, { type: "reply", threadId: added.id, body: "More", author: "Matt" }));
    next = apply(next, opsFor(next, { type: "status", threadId: added.id, status: "resolved" }));
    expect(next.threads.at(-1)).toMatchObject({ status: "resolved", comments: [{ body: "Hi" }, { body: "More" }] });
    expect(review.threads.length).toBe(next.threads.length - 1);
  });
});
