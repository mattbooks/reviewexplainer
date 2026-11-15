import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeView, type CodeViewHandle, type DiffLineAnnotation, type SelectedLineRange } from "@pierre/diffs/react";
import { fromPierreSide, makeLinesAnchor, type Anchor, type ReviewFile, type Source, type Step } from "@reviewexplainer/format";
import { Composer, Files, NoteCard, Route, StepIntro, ThreadCard, Welcome } from "./components.tsx";
import { fromBundled, fromFile, fromServer, fromUrl, type Loaded } from "./load.ts";
import { Markdown } from "./markdown.tsx";
import {
  apply,
  ConflictError,
  downloadReview,
  opsFor,
  storedReviewerName,
  storeReviewerName,
  type Action,
  type SaveState,
} from "./store.ts";
import {
  buildLayout,
  decorate,
  DEFAULT_FILTERS,
  isViewed,
  mechanicalItems,
  type Draft,
  type Filters,
  type Item,
  type SpotMeta,
} from "./view-model.ts";

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [phase, setPhase] = useState<"loading" | "welcome" | "ready">("loading");
  const [error, setError] = useState<string>();

  const open = useCallback(async (load: () => Promise<Loaded>) => {
    setError(undefined);
    try {
      setLoaded(await load());
      setPhase("ready");
    } catch (e) {
      setError((e as Error).message);
      setPhase("welcome");
    }
  }, []);

  useEffect(() => {
    const src = new URLSearchParams(location.search).get("src");
    if (src) {
      void open(() => fromUrl(src));
      return;
    }
    void (async () => {
      try {
        const local = (await fromServer()) ?? (await fromBundled());
        if (local) {
          setLoaded(local);
          setPhase("ready");
        } else setPhase("welcome");
      } catch (e) {
        setError((e as Error).message);
        setPhase("welcome");
      }
    })();
  }, [open]);

  if (phase === "loading") return <p className="loading">Loading the review…</p>;
  if (phase === "welcome" || !loaded) {
    return (
      <Welcome
        error={error}
        onFile={(file, handle) => void open(() => fromFile(file, handle))}
        onUrl={(url) => {
          const next = new URL(location.href);
          next.searchParams.set("src", url);
          history.replaceState(null, "", next);
          void open(() => fromUrl(url));
        }}
      />
    );
  }
  return <Reviewer key={loaded.name + loaded.review.subject.head.sha} loaded={loaded} />;
}

const SOURCES: Source[] = ["ai", "github", "local"];
const SOURCE_NAMES: Record<Source, string> = { ai: "AI", github: "GitHub", local: "Local" };

function Reviewer({ loaded }: { loaded: Loaded }) {
  const [review, setReview] = useState<ReviewFile>(loaded.review);
  const [save, setSave] = useState<SaveState>({ kind: "saved" });
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reviewDraft, setReviewDraft] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | undefined>();
  const [tab, setTab] = useState<"route" | "files">("route");
  const [drawer, setDrawer] = useState(false);
  const [help, setHelp] = useState(false);
  const [split, setSplit] = useState(false);
  const narrow = useNarrow();
  const [selection, setSelection] = useState<{ id: string; range: SelectedLineRange } | null>(null);
  const [reviewer, setReviewer] = useState<string | null>(loaded.reviewer ?? storedReviewerName());
  const handle = useRef<CodeViewHandle<SpotMeta, undefined>>(null);
  const backend = loaded.backend;

  const layout = useMemo(() => buildLayout(review), [review.patch, review.guide]); // eslint-disable-line react-hooks/exhaustive-deps
  const collapsedByDefault = useMemo(() => mechanicalItems(review, layout), [review.guide, layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const decorated = useMemo(
    () => decorate(review, layout, { filters, draft, expanded, collapsedByDefault }),
    [review, layout, filters, draft, expanded, collapsedByDefault],
  );
  const threadsById = useMemo(() => new Map(review.threads.map((t) => [t.id, t])), [review.threads]);
  const notesById = useMemo(() => new Map(review.annotations.map((a) => [a.id, a])), [review.annotations]);
  const stepsById = useMemo(() => new Map(review.guide.steps.map((s, i) => [s.id, { step: s, index: i }])), [review.guide.steps]);
  const openByStep = useMemo(() => {
    const m = new Map<string, number>();
    for (const [itemId, n] of decorated.openByItem) {
      const step = layout.byId.get(itemId)!.stepId;
      m.set(step, (m.get(step) ?? 0) + n);
    }
    return m;
  }, [decorated, layout]);

  const allKeys = useMemo(() => layout.infos.flatMap((i) => i.viewKeys), [layout]);
  const viewedCount = allKeys.filter((k) => k in review.state.viewed).length;

  const reviewRef = useRef(review);
  reviewRef.current = review;
  const dispatch = useCallback(
    (action: Action) => {
      const current = reviewRef.current;
      const ops = opsFor(current, action);
      if (ops.length === 0) return;
      const next = apply(current, ops);
      reviewRef.current = next;
      setReview(next);
      if (backend.memoryOnly) {
        setSave({ kind: "unsaved" });
        return;
      }
      setSave({ kind: "saving" });
      backend.persist(ops, next).then(
        () => setSave({ kind: "saved" }),
        (e: Error) => setSave({ kind: "error", message: e instanceof ConflictError ? e.message : `Not saved: ${e.message}` }),
      );
    },
    [backend],
  );

  // Read the name through a ref: a first comment sets the name and submits in the same tick.
  const reviewerRef = useRef(reviewer);
  const authorName = () => reviewerRef.current ?? "Reviewer";
  const setName = (name: string) => {
    reviewerRef.current = name;
    setReviewer(name);
    storeReviewerName(name);
  };

  const goTo = useCallback((id: string | undefined) => {
    if (!id) return;
    setCursor(id);
    // Items are measured as they render (narration and threads change their
    // height), so jump, then re-align once the target has been laid out.
    const align = () => handle.current?.scrollTo({ type: "item", id, align: "start", behavior: "instant" });
    align();
    requestAnimationFrame(() => requestAnimationFrame(align));
    window.setTimeout(align, 180);
  }, []);

  const toggleViewed = useCallback(
    (itemId: string) => {
      const info = layout.byId.get(itemId);
      if (!info) return;
      const viewed = isViewed(review, info);
      dispatch({ type: "viewed", keys: info.viewKeys, viewed: !viewed, ...(reviewerRef.current ? { by: reviewerRef.current } : {}) });
      setExpanded((s) => {
        const n = new Set(s);
        n.delete(itemId);
        return n;
      });
    },
    [layout, review, dispatch, reviewer],
  );

  const toggleExpanded = useCallback(
    (itemId: string) => {
      const item = decorated.items.find((i) => i.id === itemId);
      setExpanded((s) => {
        const n = new Set(s);
        if (item?.collapsed) n.add(itemId);
        else n.delete(itemId);
        return n;
      });
      if (item && !item.collapsed && !collapsedByDefault.has(itemId) && !isViewed(review, layout.byId.get(itemId)!)) {
        // Collapsing an unviewed item counts as reading it.
        toggleViewed(itemId);
      }
    },
    [decorated.items, collapsedByDefault, review, layout, toggleViewed],
  );

  const startDraft = useCallback(
    (itemId: string, range: SelectedLineRange) => {
      const info = layout.byId.get(itemId);
      if (!info) return;
      const endSide = range.endSide ?? range.side ?? "additions";
      const sameSide = (range.side ?? "additions") === endSide;
      const a = Math.min(range.start, range.end);
      const b = Math.max(range.start, range.end);
      setReviewDraft(false);
      setDraft({ itemId, path: info.path, side: fromPierreSide(endSide), start: sameSide ? a : range.end, end: sameSide ? b : range.end });
    },
    [layout],
  );

  const submitDraft = (body: string) => {
    if (!draft) return;
    let anchor: Anchor;
    try {
      anchor = makeLinesAnchor(
        layout.model,
        { path: draft.path, side: draft.side, start: draft.start, end: draft.end, commit: review.subject.head.sha },
        review,
      );
    } catch {
      anchor = { kind: "file", path: draft.path };
    }
    dispatch({ type: "comment", anchor, body, author: authorName() });
    setDraft(null);
  };

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, select, [contenteditable='true']") || e.metaKey || e.ctrlKey || e.altKey)) return;
      const ids = layout.infos.map((i) => i.id);
      const index = cursor ? ids.indexOf(cursor) : -1;
      const stepIndex = cursor ? layout.byId.get(cursor)!.stepIndex : -1;
      switch (e.key) {
        case "j":
          goTo(ids[Math.min(ids.length - 1, index + 1)]);
          break;
        case "k":
          goTo(ids[Math.max(0, index - 1)]);
          break;
        case "n": {
          const next = review.guide.steps[Math.min(review.guide.steps.length - 1, stepIndex + 1)];
          if (next) goTo(layout.firstItemOfStep.get(next.id));
          break;
        }
        case "p": {
          const current = review.guide.steps[stepIndex];
          const atStart = !current || layout.firstItemOfStep.get(current.id) === cursor;
          const target = review.guide.steps[atStart ? Math.max(0, stepIndex - 1) : stepIndex];
          if (target) goTo(layout.firstItemOfStep.get(target.id));
          break;
        }
        case "v":
          if (cursor) {
            const info = layout.byId.get(cursor);
            const wasViewed = info ? isViewed(review, info) : true;
            toggleViewed(cursor);
            // Like GitHub: marking a file viewed moves on to the next one.
            if (!wasViewed && index + 1 < ids.length) goTo(ids[index + 1]);
          }
          break;
        case "x":
          if (cursor) toggleExpanded(cursor);
          break;
        case "c":
          if (selection) {
            e.preventDefault();
            startDraft(selection.id, selection.range);
          }
          break;
        case "?":
          setHelp((h) => !h);
          break;
        case "Escape":
          setDraft(null);
          setHelp(false);
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout, cursor, review, goTo, toggleViewed, toggleExpanded, selection, startDraft]);

  // Warn before leaving with edits that only live in this tab.
  useEffect(() => {
    if (save.kind !== "unsaved") return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [save.kind]);

  const reload = async () => {
    const fresh = await fromServer();
    if (fresh) {
      setReview(fresh.review);
      setSave({ kind: "saved" });
    }
  };

  const threadProps = (id: string) => {
    const t = threadsById.get(id)!;
    return {
      thread: t,
      needName: !reviewer,
      onName: setName,
      onReply: (body: string) => dispatch({ type: "reply", threadId: id, body, author: authorName() }),
      onStatus: (status: "open" | "resolved" | "outdated") => dispatch({ type: "status", threadId: id, status }),
    };
  };

  const renderAnnotation = (annotation: DiffLineAnnotation<SpotMeta>, _f: unknown, item: Item) => {
    const meta = annotation.metadata;
    const step = meta.narrativeStep ? stepsById.get(meta.narrativeStep) : undefined;
    return (
      <div className="spot">
        {step ? <StepIntro step={step.step} index={step.index} total={review.guide.steps.length} /> : null}
        {meta.noteIds.map((id) => {
          const note = notesById.get(id);
          return note ? <NoteCard key={id} note={note} /> : null;
        })}
        {meta.threadIds.map((id) => (threadsById.has(id) ? <ThreadCard key={id} {...threadProps(id)} /> : null))}
        {meta.composer && draft && draft.itemId === item.id ? (
          <Composer
            placeholder="Leave a comment"
            submitLabel="Comment"
            context={`${draft.path}, ${draft.side === "old" ? "old " : ""}line${draft.start === draft.end ? ` ${draft.end}` : `s ${draft.start}–${draft.end}`}`}
            needName={!reviewer}
            onName={setName}
            onCancel={() => setDraft(null)}
            onSubmit={submitDraft}
          />
        ) : null}
      </div>
    );
  };

  const renderHeaderPrefix = (item: Item) => {
    const info = layout.byId.get(item.id);
    if (!info) return null;
    return (
      <span className="item-step" title={stepsById.get(info.stepId)?.step.title}>
        {info.stepIndex + 1}
      </span>
    );
  };

  const renderHeaderMetadata = (item: Item) => {
    const info = layout.byId.get(item.id);
    if (!info) return null;
    const open = decorated.openByItem.get(item.id) ?? 0;
    const viewed = isViewed(review, info);
    return (
      <span className="item-meta">
        {open > 0 ? <span className="item-open">{open} open</span> : null}
        <button type="button" className="item-toggle" onClick={() => toggleExpanded(item.id)} aria-expanded={!item.collapsed}>
          {item.collapsed ? "Show" : "Hide"}
        </button>
        <label className="item-viewed">
          <input type="checkbox" checked={viewed} onChange={() => toggleViewed(item.id)} />
          Viewed
        </label>
      </span>
    );
  };

  const subject = review.subject;
  const title = subject.pr ? subject.pr.title : `${subject.base.ref ?? subject.base.sha.slice(0, 8)} → ${subject.head.ref ?? subject.head.sha.slice(0, 8)}`;

  const renderOverview = () => (
    <section className="overview">
      <h1>{title}</h1>
      <p className="refs">
        {subject.pr ? (
          <a href={subject.pr.url} target="_blank" rel="noreferrer noopener">
            #{subject.pr.number} by {subject.pr.author}
          </a>
        ) : null}
        <span>
          <code>{subject.base.ref ?? subject.base.sha.slice(0, 12)}</code> to <code>{subject.head.ref ?? subject.head.sha.slice(0, 12)}</code> at{" "}
          <code>{subject.head.sha.slice(0, 12)}</code>
        </span>
        <span>
          {review.guide.generatedBy === "ai" ? "Order and notes written by AI" : review.guide.generatedBy === "heuristic" ? "Order from file roles and imports" : "Order set by hand"}
        </span>
      </p>
      {review.guide.overview ? <Markdown text={review.guide.overview} className="narrative" /> : null}
      {loaded.warnings.length ? (
        <details className="warnings">
          <summary>This file has {loaded.warnings.length} problem{loaded.warnings.length === 1 ? "" : "s"}; some changes may be missing from the steps</summary>
          <ul>
            {loaded.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="review-threads">
        {decorated.reviewNoteIds.map((id) => (
          <NoteCard key={id} note={notesById.get(id)!} />
        ))}
        {decorated.reviewThreadIds.map((id) => (
          <ThreadCard key={id} {...threadProps(id)} />
        ))}
        {reviewDraft ? (
          <Composer
            placeholder="Comment on the whole change"
            submitLabel="Comment"
            needName={!reviewer}
            onName={setName}
            onCancel={() => setReviewDraft(false)}
            onSubmit={(body) => {
              dispatch({ type: "comment", anchor: { kind: "review" }, body, author: authorName() });
              setReviewDraft(false);
            }}
          />
        ) : (
          <button type="button" className="quiet" onClick={() => setReviewDraft(true)}>
            Comment on the whole change
          </button>
        )}
      </div>
    </section>
  );

  const outdated = decorated.outdatedThreadIds;

  return (
    <div className="shell" data-drawer={drawer || undefined}>
      <header className="topbar">
        <div className="progress" title={`${viewedCount} of ${allKeys.length} parts viewed`}>
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <circle cx="18" cy="18" r="15" className="track" />
            <circle
              cx="18"
              cy="18"
              r="15"
              className="fill"
              strokeDasharray={`${allKeys.length ? (viewedCount / allKeys.length) * 94.25 : 0} 94.25`}
            />
          </svg>
          <span>
            {viewedCount}/{allKeys.length}
          </span>
        </div>
        <p className="topbar-title">{title}</p>
        <fieldset className="filters">
          <legend className="sr-only">Show comments from</legend>
          {SOURCES.map((s) => (
            <label key={s} data-source={s}>
              <input
                type="checkbox"
                checked={filters.sources[s]}
                onChange={(e) => setFilters((f) => ({ ...f, sources: { ...f.sources, [s]: e.target.checked } }))}
              />
              {SOURCE_NAMES[s]}
            </label>
          ))}
          <label>
            <input type="checkbox" checked={filters.showNotes} onChange={(e) => setFilters((f) => ({ ...f, showNotes: e.target.checked }))} />
            Notes
          </label>
          <label>
            <input
              type="checkbox"
              checked={filters.showResolved}
              onChange={(e) => setFilters((f) => ({ ...f, showResolved: e.target.checked }))}
            />
            Resolved
          </label>
        </fieldset>
        <button type="button" className="quiet split-toggle" onClick={() => setSplit((s) => !s)} aria-pressed={split}>
          {split ? "Unified" : "Split"}
        </button>
        {outdated.length ? (
          <button type="button" className="quiet" onClick={() => setDrawer((d) => !d)} aria-expanded={drawer}>
            Outdated ({outdated.length})
          </button>
        ) : null}
        <SaveStatus
          state={save}
          label={backend.label}
          onDownload={() => {
            downloadReview(review, loaded.name.replace(/\.gz$/, ""));
            setSave({ kind: "saved" });
          }}
          onSaveInPlace={
            backend.canSaveInPlace
              ? async () => {
                  try {
                    await backend.saveInPlace!(review);
                    setSave({ kind: "saved" });
                  } catch (e) {
                    setSave({ kind: "error", message: `Not saved: ${(e as Error).message}` });
                  }
                }
              : undefined
          }
          onReload={backend.memoryOnly ? undefined : reload}
        />
        <button type="button" className="quiet icon" onClick={() => setHelp((h) => !h)} aria-label="Keyboard shortcuts">
          ?
        </button>
      </header>

      <nav className="sidebar" aria-label="Review navigation">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "route"} onClick={() => setTab("route")}>
            Steps
          </button>
          <button type="button" role="tab" aria-selected={tab === "files"} onClick={() => setTab("files")}>
            Files
          </button>
        </div>
        {tab === "route" ? (
          <Route
            review={review}
            layout={layout}
            currentStep={cursor ? layout.byId.get(cursor)?.stepId : undefined}
            openByStep={openByStep}
            onPick={(step: Step) => goTo(layout.firstItemOfStep.get(step.id))}
          />
        ) : (
          <Files review={review} layout={layout} openByPath={decorated.openByPath} onPick={(path) => goTo(layout.firstItemOfFile.get(path))} />
        )}
      </nav>

      <main className="code">
        <CodeView<SpotMeta, undefined>
          ref={handle}
          items={decorated.items}
          options={{
            diffStyle: split && !narrow ? "split" : "unified",
            stickyHeaders: true,
            themeType: "system",
            overflow: narrow ? "wrap" : "scroll",
            enableGutterUtility: true,
            enableLineSelection: true,
            lineDiffType: "word",
            layout: { paddingTop: 0, paddingBottom: 240, gap: 16 },
            onGutterUtilityClick: ((range: SelectedLineRange, context: { item: Item }) => {
              setCursor(context.item.id);
              startDraft(context.item.id, range);
            }) as never,
          }}
          onSelectedLinesChange={(sel) => {
            setSelection(sel);
            if (sel) setCursor(sel.id);
          }}
          renderCodeViewHeader={renderOverview}
          renderAnnotation={((annotation: DiffLineAnnotation<SpotMeta>, fileDiff: unknown, item: Item) =>
            renderAnnotation(annotation, fileDiff, item)) as never}
          renderHeaderPrefix={renderHeaderPrefix}
          renderHeaderMetadata={renderHeaderMetadata}
        />
      </main>

      {drawer ? (
        <aside className="drawer" aria-label="Outdated threads">
          <header>
            <h2>Not on the current code</h2>
            <button type="button" className="quiet" onClick={() => setDrawer(false)}>
              Close
            </button>
          </header>
          <p>These threads point at lines that changed or left the diff after a new push.</p>
          {outdated.map((id) => {
            const t = threadsById.get(id)!;
            const where = t.anchor.kind === "lines" ? `${t.anchor.path}:${t.anchor.start}` : t.anchor.kind === "review" ? "Whole change" : t.anchor.path;
            return (
              <div key={id} className="outdated-item">
                <p className="where">{where}</p>
                <ThreadCard {...threadProps(id)} />
              </div>
            );
          })}
        </aside>
      ) : null}

      {help ? (
        <div className="help" role="dialog" aria-label="Keyboard shortcuts" onClick={() => setHelp(false)}>
          <dl onClick={(e) => e.stopPropagation()}>
            <dt>j / k</dt>
            <dd>Next / previous file in the route</dd>
            <dt>n / p</dt>
            <dd>Next / previous step</dd>
            <dt>v</dt>
            <dd>Mark the current file viewed</dd>
            <dt>x</dt>
            <dd>Show or hide the current file</dd>
            <dt>c</dt>
            <dd>Comment on the selected lines</dd>
            <dt>Esc</dt>
            <dd>Close the comment box</dd>
          </dl>
          <p>Select lines by dragging over the line numbers, or click the + in the gutter to comment.</p>
        </div>
      ) : null}
    </div>
  );
}

/** True on phone-sized screens: wrap long lines and keep the unified view. */
function useNarrow(): boolean {
  const query = "(max-width: 860px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function SaveStatus(props: {
  state: SaveState;
  label: string;
  onDownload: () => void;
  onSaveInPlace: (() => void) | undefined;
  onReload: (() => void) | undefined;
}) {
  const s = props.state;
  if (s.kind === "error") {
    return (
      <div className="save save-error" role="alert">
        <span>{s.message}</span>
        {props.onReload ? (
          <button type="button" onClick={props.onReload}>
            Reload
          </button>
        ) : null}
      </div>
    );
  }
  if (s.kind === "unsaved") {
    return (
      <div className="save save-unsaved">
        {props.onSaveInPlace ? (
          <button type="button" className="primary" onClick={props.onSaveInPlace}>
            Save
          </button>
        ) : null}
        <button type="button" className={props.onSaveInPlace ? "" : "primary"} onClick={props.onDownload}>
          Download
        </button>
      </div>
    );
  }
  return (
    <p className="save" title={props.label}>
      {s.kind === "saving" ? "Saving…" : props.label.startsWith("Saved") ? "Saved" : "No changes"}
    </p>
  );
}
