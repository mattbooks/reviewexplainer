/** The list of reviews `greview watch` keeps, served by `greview inbox` or `greview watch --serve`. */
import { useEffect, useState } from "react";

interface Entry {
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  status: "preparing" | "queued" | "reviewing" | "ready" | "failed" | "paused" | "closed" | "skipped";
  filters: string[];
  headSha?: string;
  reviewedHead?: string;
  pendingHead?: string;
  openThreads: number;
  aiFindings: number;
  viewed: number;
  total: number;
  lastSummary?: string;
  lastError?: string;
  changedAt: string;
  merged?: boolean;
}

const STATUS: Record<Entry["status"], string> = {
  preparing: "Setting up",
  queued: "Waiting for the AI",
  reviewing: "AI reviewing",
  ready: "Ready",
  failed: "Failed",
  paused: "Paused",
  closed: "Closed",
  skipped: "Skipped",
};

function statusText(e: Entry): string {
  if (e.status === "closed") return e.merged ? "Merged" : "Closed";
  if (e.status === "ready" && e.pendingHead) return "New commits; re-review soon";
  if (e.status === "queued" && e.reviewedHead) return "Waiting for re-review";
  if (e.status === "reviewing" && e.reviewedHead) return "AI re-reviewing";
  return STATUS[e.status];
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function Inbox() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch("api/reviews", { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`The inbox did not load (${res.status})`);
        const list = (await res.json()) as Entry[];
        if (!stop) {
          setEntries(list);
          setError(undefined);
        }
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 10_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  const active = entries?.filter((e) => e.status !== "closed") ?? [];
  const closed = entries?.filter((e) => e.status === "closed") ?? [];

  return (
    <main className="inbox">
      <header className="inbox-head">
        <h1>Reviews</h1>
        <p>
          {entries === null
            ? "Loading…"
            : `${active.length} open pull request${active.length === 1 ? "" : "s"} from your watch filters`}
        </p>
      </header>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {entries && entries.length === 0 ? (
        <p className="inbox-empty">
          Nothing here yet. Run <code>greview watch</code>; pull requests matching your filters appear as soon as they are set up.
        </p>
      ) : null}
      <ol className="inbox-list">
        {active.map((e) => (
          <Row key={e.key} entry={e} />
        ))}
      </ol>
      {closed.length ? (
        <>
          <h2 className="inbox-sub">Recently closed</h2>
          <ol className="inbox-list">
            {closed.map((e) => (
              <Row key={e.key} entry={e} />
            ))}
          </ol>
        </>
      ) : null}
    </main>
  );
}

function Row({ entry: e }: { entry: Entry }) {
  const href = `?key=${encodeURIComponent(e.key)}`;
  const done = e.total > 0 && e.viewed >= e.total;
  return (
    <li className="inbox-row" data-status={e.status} data-done={done || undefined}>
      <span className="inbox-marker" aria-hidden="true" />
      <div className="inbox-body">
        <a className="inbox-title" href={href}>
          {e.title}
        </a>
        <p className="inbox-meta">
          <span>
            {e.repo}#{e.number}
          </span>
          <span className="inbox-status">{statusText(e)}</span>
          {e.openThreads ? <span className="inbox-open">{e.openThreads} open</span> : null}
          {e.aiFindings ? <span>{e.aiFindings} from AI</span> : null}
          <span>
            {e.viewed}/{e.total} viewed
          </span>
          <span>{ago(e.changedAt)}</span>
          <a href={e.url} target="_blank" rel="noreferrer noopener">
            GitHub
          </a>
        </p>
        {e.status === "failed" && e.lastError ? <p className="inbox-error">{e.lastError.split("\n")[0]}</p> : null}
        {e.status !== "failed" && e.lastSummary ? <p className="inbox-summary">{e.lastSummary}</p> : null}
      </div>
    </li>
  );
}
