import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { FileTreeSortEntry, GitStatusEntry } from "@pierre/trees";
import type { Annotation, ReviewFile, Step, Thread } from "@reviewexplainer/format";
import { Markdown } from "./markdown.tsx";
import { stepProgress, type Layout } from "./view-model.ts";

const SOURCE_LABEL = { ai: "AI", github: "GitHub", local: "You" } as const;

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

/* ---------- Route: the steps as a line of stops ---------- */

export function Route(props: {
  review: ReviewFile;
  layout: Layout;
  currentStep: string | undefined;
  openByStep: Map<string, number>;
  onPick: (step: Step) => void;
}) {
  const { review, layout } = props;
  return (
    <ol className="route" aria-label="Reading order">
      {review.guide.steps.map((step, i) => {
        const p = stepProgress(review, layout, step.id);
        const done = p.total > 0 && p.viewed === p.total;
        const open = props.openByStep.get(step.id) ?? 0;
        const current = props.currentStep === step.id;
        return (
          <li
            key={step.id}
            className="stop"
            data-done={done || undefined}
            data-current={current || undefined}
            data-kind={step.kind ?? "core"}
          >
            <button type="button" onClick={() => props.onPick(step)} aria-current={current ? "step" : undefined}>
              <span className="stop-marker" aria-hidden="true">
                {i + 1}
              </span>
              <span className="stop-body">
                <span className="stop-title">{step.title}</span>
                <span className="stop-meta">
                  <span>
                    {p.viewed}/{p.total} viewed
                  </span>
                  {open > 0 ? <span className="stop-open">{open} open</span> : null}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- Files: @pierre/trees ordered by first appearance in the guide ---------- */

export function Files(props: {
  review: ReviewFile;
  layout: Layout;
  openByPath: Map<string, number>;
  onPick: (path: string) => void;
}) {
  const { review, layout } = props;
  const paths = useMemo(() => review.files.map((f) => f.path), [review.files]);
  const order = useMemo(() => {
    const m = new Map<string, number>();
    layout.infos.forEach((info, i) => {
      if (!m.has(info.path)) m.set(info.path, i);
      const parts = info.path.split("/");
      for (let n = 1; n < parts.length; n++) {
        const dir = parts.slice(0, n).join("/");
        if (!m.has(dir)) m.set(dir, i);
      }
    });
    return m;
  }, [layout]);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () =>
      review.files.map((f) => ({
        path: f.path,
        status: f.status === "added" ? "added" : f.status === "deleted" ? "deleted" : f.status === "renamed" ? "renamed" : "modified",
      })),
    [review.files],
  );
  const counts = useRef(props.openByPath);
  counts.current = props.openByPath;
  const pick = useRef(props.onPick);
  pick.current = props.onPick;

  const { model } = useFileTree({
    paths,
    gitStatus,
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    search: true,
    sort: (a: FileTreeSortEntry, b: FileTreeSortEntry) =>
      (order.get(a.path.replace(/\/$/, "")) ?? 1e9) - (order.get(b.path.replace(/\/$/, "")) ?? 1e9) || a.path.localeCompare(b.path),
    renderRowDecoration: ({ row }) => {
      const n = counts.current.get(row.path);
      return n ? { text: String(n), title: `${n} open thread${n === 1 ? "" : "s"}` } : null;
    },
    onSelectionChange: (selected: readonly string[]) => {
      const path = selected[0];
      if (path && paths.includes(path)) pick.current(path);
    },
  });
  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus, props.openByPath]);
  return <FileTree model={model} className="files-tree" />;
}

/* ---------- Threads and notes ---------- */

export function ThreadCard(props: {
  thread: Thread;
  onReply: (body: string) => void;
  onStatus: (status: Thread["status"]) => void;
  needName: boolean;
  onName: (name: string) => void;
}) {
  const t = props.thread;
  const [replying, setReplying] = useState(false);
  return (
    <article className="thread" data-source={t.source} data-status={t.status}>
      <header className="thread-head">
        <span className="source-tag">{SOURCE_LABEL[t.source]}</span>
        {t.severity ? <span className={`severity sev-${t.severity}`}>{t.severity}</span> : null}
        {t.category ? <span className="category">{t.category}</span> : null}
        {t.status !== "open" ? <span className="status">{t.status}</span> : null}
        {t.external?.github?.url ? (
          <a className="gh-link" href={t.external.github.url} target="_blank" rel="noreferrer noopener">
            On GitHub
          </a>
        ) : null}
      </header>
      {t.comments.map((c) => (
        <div className="comment" key={c.id}>
          <div className="comment-meta">
            <strong>{c.author.name}</strong>
            <time dateTime={c.createdAt}>{timeAgo(c.createdAt)}</time>
          </div>
          <Markdown text={c.body} />
        </div>
      ))}
      {t.suggestion ? (
        <figure className="md-suggestion">
          <figcaption>Suggested change</figcaption>
          <pre>
            <code>{t.suggestion.replacement}</code>
          </pre>
        </figure>
      ) : null}
      {replying ? (
        <Composer
          placeholder="Reply"
          submitLabel="Reply"
          needName={props.needName}
          onName={props.onName}
          onCancel={() => setReplying(false)}
          onSubmit={(body) => {
            props.onReply(body);
            setReplying(false);
          }}
        />
      ) : (
        <footer className="thread-actions">
          <button type="button" onClick={() => setReplying(true)}>
            Reply
          </button>
          {t.status === "resolved" ? (
            <button type="button" onClick={() => props.onStatus("open")}>
              Reopen
            </button>
          ) : (
            <button type="button" onClick={() => props.onStatus("resolved")}>
              Resolve
            </button>
          )}
        </footer>
      )}
    </article>
  );
}

export function NoteCard({ note }: { note: Annotation }) {
  return (
    <aside className="note" data-source={note.source}>
      <Markdown text={note.body} />
      <span className="note-by">{note.author?.name ?? SOURCE_LABEL[note.source]}</span>
    </aside>
  );
}

export function Composer(props: {
  placeholder: string;
  submitLabel: string;
  needName: boolean;
  onName: (name: string) => void;
  onSubmit: (body: string) => void;
  onCancel: () => void;
  context?: string;
}) {
  const [body, setBody] = useState("");
  const [name, setName] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!body.trim()) return;
    if (props.needName) {
      if (!name.trim()) return;
      props.onName(name.trim());
    }
    props.onSubmit(body.trim());
    setBody("");
  };
  return (
    <form
      className="composer"
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onCancel();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
      }}
    >
      {props.context ? <p className="composer-context">{props.context}</p> : null}
      {props.needName ? (
        <label className="composer-name">
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
        </label>
      ) : null}
      <textarea
        ref={ref}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={props.placeholder}
        rows={3}
        aria-label={props.placeholder}
      />
      <div className="composer-actions">
        <button type="submit" className="primary" disabled={!body.trim() || (props.needName && !name.trim())}>
          {props.submitLabel}
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <span className="hint">⌘/Ctrl + Enter</span>
      </div>
    </form>
  );
}

export function StepIntro({ step, index, total }: { step: Step; index: number; total: number }) {
  return (
    <section className="step-intro" data-kind={step.kind ?? "core"}>
      <p className="step-count">
        Step {index + 1} of {total}
      </p>
      <h2>{step.title}</h2>
      <Markdown text={step.narrative} className="narrative" />
    </section>
  );
}

/* ---------- Welcome: open a file in hosted mode ---------- */

export function Welcome(props: {
  error?: string | undefined;
  onFile: (file: File, handle?: unknown) => void;
  onUrl: (url: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [hasExample, setHasExample] = useState(false);
  useEffect(() => {
    // A deployment can ship example.review.json next to the app to show what a review looks like.
    fetch("example.review.json", { method: "HEAD" })
      .then((r) => setHasExample(r.ok && (r.headers.get("content-type") ?? "").includes("json")))
      .catch(() => setHasExample(false));
  }, []);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pick = async () => {
    const w = window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<{ getFile(): Promise<File> }[]> };
    if (w.showOpenFilePicker) {
      try {
        const [handle] = await w.showOpenFilePicker({
          types: [{ description: "Review files", accept: { "application/json": [".json"], "application/gzip": [".gz"] } }],
        });
        if (handle) props.onFile(await handle.getFile(), handle);
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    }
    input.current?.click();
  };
  return (
    <main
      className="welcome"
      data-over={over || undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) props.onFile(f);
      }}
    >
      <div className="welcome-inner">
        <h1>Read a change in the order it makes sense</h1>
        <p>
          Open a <code>.review.json</code> file made by <code>greview init</code>. It stays in this browser tab; nothing is
          uploaded.
        </p>
        <div className="welcome-actions">
          <button type="button" className="primary" onClick={pick}>
            Open a review file
          </button>
          <span>or drop it anywhere on this page</span>
        </div>
        {hasExample ? (
          <p className="welcome-example">
            <button type="button" onClick={() => props.onUrl(new URL("example.review.json", location.href).href)}>
              Try the example
            </button>{" "}
            A small change with an AI-written guide, findings and a GitHub thread.
          </p>
        ) : null}
        <input
          ref={input}
          type="file"
          accept=".json,.gz,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) props.onFile(f);
          }}
        />
        <form
          className="welcome-url"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) props.onUrl(url.trim());
          }}
        >
          <label htmlFor="src-url">Or load one from a URL (a gist, a raw GitHub file or a CI artifact)</label>
          <div>
            <input id="src-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
            <button type="submit">Load</button>
          </div>
        </form>
        {props.error ? (
          <pre className="error" role="alert">
            {props.error}
          </pre>
        ) : null}
        <p className="welcome-cli">
          To save comments straight back to the file, run <code>greview serve</code> instead.
        </p>
      </div>
    </main>
  );
}
