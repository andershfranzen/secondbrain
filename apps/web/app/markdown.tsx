import { Fragment, type ReactNode } from "react";

/**
 * The light Markdown an answer may use: paragraphs, bullet and numbered
 * lists, headings, bold, italic and inline code. Everything else stays text;
 * raw HTML is never interpreted.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null,
    paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length)
      blocks.push(<p key={blocks.length}>{inline(paragraph.join("\n"))}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((item, i) => (
        <li key={i}>{inline(item)}</li>
      ));
      blocks.push(
        list.ordered ? (
          <ol key={blocks.length}>{items}</ol>
        ) : (
          <ul key={blocks.length}>{items}</ul>
        ),
      );
    }
    list = null;
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line),
      numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line),
      heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else if (heading) {
      flushParagraph();
      flushList();
      blocks.push(
        <p key={blocks.length} className="markdown-heading">
          {inline(heading[1]!)}
        </p>,
      );
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return <>{blocks}</>;
}

const marks =
  /(\*\*|__)(?=\S)([\s\S]*?\S)\1|(\*|_)(?=\S)([\s\S]*?\S)\3(?![\p{L}\p{N}])|`([^`\n]+)`/gu;

function inline(text: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(marks)) {
    // Underscores inside words (snake_case) are not emphasis.
    if (m[3] === "_" && /[\p{L}\p{N}]/u.test(text[m.index - 1] ?? "")) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = out.length;
    if (m[2] !== undefined) out.push(<strong key={key}>{inline(m[2])}</strong>);
    else if (m[4] !== undefined) out.push(<em key={key}>{inline(m[4])}</em>);
    else out.push(<code key={key}>{m[5]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.map((part, i) => <Fragment key={i}>{part}</Fragment>);
}
