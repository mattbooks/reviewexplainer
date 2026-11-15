/**
 * A small Markdown subset rendered straight to React elements (never raw
 * HTML), enough for narratives and review comments: paragraphs, lists,
 * quotes, fenced code, inline code, bold, italics and http(s) links.
 */
import { Fragment, type ReactNode } from "react";

function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(m[2].slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(m[3].slice(1, -1), k)}</em>);
    else if (m[4]) {
      const label = m[4].slice(1, m[4].indexOf("]("));
      out.push(
        <a key={k} href={m[5]} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      const lang = fence[1];
      blocks.push(
        <figure key={key++} className={lang === "suggestion" ? "md-suggestion" : "md-code"}>
          {lang === "suggestion" ? <figcaption>Suggested change</figcaption> : null}
          <pre>
            <code>{body.join("\n")}</code>
          </pre>
        </figure>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
        i++;
      }
      const children = items.map((it, j) => <li key={j}>{inline(it, `l${key}-${j}`)}</li>);
      blocks.push(ordered ? <ol key={key++}>{children}</ol> : <ul key={key++}>{children}</ul>);
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) quote.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push(
        <blockquote key={key++}>
          <Markdown text={quote.join("\n")} />
        </blockquote>,
      );
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <p key={key++} className="md-heading">
          {inline(heading[1]!, `h${key}`)}
        </p>,
      );
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(```|>|#{1,6}\s|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(
      <p key={key++}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 ? " " : null}
            {inline(p, `p${key}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className={className ? `md ${className}` : "md"}>{blocks}</div>;
}
