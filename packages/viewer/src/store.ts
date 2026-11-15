/**
 * Edits are expressed as JSON Patch ops on /threads and /state, applied to
 * the in-memory review at once, then persisted by the active backend:
 * `greview serve` (PATCH with If-Match), a file handle (File System Access),
 * or nowhere until the user exports.
 */
import {
  applyJsonPatch,
  newId,
  nowIso,
  pointer,
  type Anchor,
  type JsonPatchOp,
  type ReviewFile,
  type Thread,
} from "@reviewexplainer/format";

export type Action =
  | { type: "comment"; anchor: Anchor; body: string; author: string }
  | { type: "reply"; threadId: string; body: string; author: string }
  | { type: "status"; threadId: string; status: Thread["status"] }
  | { type: "viewed"; keys: string[]; viewed: boolean; by?: string };

export function opsFor(review: ReviewFile, action: Action): JsonPatchOp[] {
  switch (action.type) {
    case "comment": {
      const thread: Thread = {
        id: newId("local"),
        anchor: action.anchor,
        source: "local",
        status: "open",
        comments: [{ id: newId("c"), author: { name: action.author, kind: "human" }, body: action.body, createdAt: nowIso() }],
      };
      return [{ op: "add", path: "/threads/-", value: thread }];
    }
    case "reply": {
      const i = review.threads.findIndex((t) => t.id === action.threadId);
      if (i === -1) return [];
      const comment = { id: newId("c"), author: { name: action.author, kind: "human" }, body: action.body, createdAt: nowIso() };
      return [
        { op: "test", path: pointer("threads", i, "id"), value: action.threadId },
        { op: "add", path: pointer("threads", i, "comments", "-"), value: comment },
      ];
    }
    case "status": {
      const i = review.threads.findIndex((t) => t.id === action.threadId);
      if (i === -1) return [];
      return [
        { op: "test", path: pointer("threads", i, "id"), value: action.threadId },
        { op: "replace", path: pointer("threads", i, "status"), value: action.status },
      ];
    }
    case "viewed": {
      const ops: JsonPatchOp[] = [];
      for (const key of action.keys) {
        const has = key in review.state.viewed;
        if (action.viewed && !has) {
          ops.push({ op: "add", path: pointer("state", "viewed", key), value: { at: nowIso(), ...(action.by ? { by: action.by } : {}) } });
        } else if (!action.viewed && has) {
          ops.push({ op: "remove", path: pointer("state", "viewed", key) });
        }
      }
      return ops;
    }
  }
}

export type SaveState = { kind: "saved" } | { kind: "saving" } | { kind: "unsaved" } | { kind: "error"; message: string };

export interface Backend {
  label: string;
  /** Persist ops that were already applied locally. Resolves with the server's copy, if any. */
  persist(ops: JsonPatchOp[], after: ReviewFile): Promise<ReviewFile | void>;
  /** True when edits are kept only in memory until exported. */
  readonly memoryOnly: boolean;
  canSaveInPlace?: boolean;
  saveInPlace?(review: ReviewFile): Promise<void>;
}

export class ConflictError extends Error {}

export function serverBackend(initialEtag: string | null): Backend {
  let etag = initialEtag;
  let queue = Promise.resolve<ReviewFile | void>(undefined);
  return {
    label: "Saved to the review file",
    memoryOnly: false,
    persist(ops) {
      queue = queue.then(async () => {
        const res = await fetch("api/review", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) },
          body: JSON.stringify(ops),
        });
        if (res.status === 409) throw new ConflictError("The review file changed on disk. Reload to get the latest version.");
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string; details?: string[] };
          throw new Error([body.error ?? `Save failed (${res.status})`, ...(body.details ?? [])].join("\n"));
        }
        etag = res.headers.get("ETag");
        return (await res.json()) as ReviewFile;
      });
      return queue;
    },
  };
}

interface WritableHandle {
  name: string;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

export function memoryBackend(handle?: WritableHandle): Backend {
  return {
    label: handle ? `Editing ${handle.name}` : "Changes are kept in this tab until you download them",
    memoryOnly: true,
    canSaveInPlace: Boolean(handle),
    async persist() {},
    async saveInPlace(review) {
      if (!handle) return;
      const w = await handle.createWritable();
      await w.write(`${JSON.stringify(review, null, 2)}\n`);
      await w.close();
    },
  };
}

export function apply(review: ReviewFile, ops: JsonPatchOp[]): ReviewFile {
  return ops.length ? applyJsonPatch(review, ops) : review;
}

export function downloadReview(review: ReviewFile, name: string): void {
  const blob = new Blob([`${JSON.stringify(review, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const NAME_KEY = "greview.reviewer";

export function storedReviewerName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

export function storeReviewerName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Storage can be unavailable (private mode, sandboxed frames); the name then lasts for this tab.
  }
}
