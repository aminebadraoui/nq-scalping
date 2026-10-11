/* ------------------------------------------------------------------ *
 * Minimal markdown → JSX renderer for the study docs subset:
 * headings, blockquotes, bold/italic, inline code, fenced code blocks,
 * unordered/ordered lists (one nesting level), tables, hr, links.
 * Server component — no content is serialized to the client.
 * ------------------------------------------------------------------ */

import React from "react";

/** inline spans: `code`, [text](url), **bold**, *italic* — single pass */
function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("`")) {
      out.push(
        <code key={key} className="rounded bg-zinc-950/80 px-1 py-0.5 font-mono text-[10px] text-zinc-300">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      out.push(
        <a key={key} href={mm?.[2] ?? "#"} className="text-long underline decoration-zinc-700 underline-offset-2 hover:text-emerald-200" target="_blank" rel="noreferrer">
          {mm?.[1]}
        </a>,
      );
    } else if (tok.startsWith("**")) {
      out.push(
        <strong key={key} className="font-semibold text-zinc-200">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function table(lines: string[], keyBase: string): React.ReactNode {
  const rows = lines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .map((l) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
  const body = rows.filter((_, ri) => !/^:?-{2,}:?$/.test(rows[ri][0]) && !rows[ri].every((c) => /^:?-{2,}:?$/.test(c)));
  const header = body.length > 0 ? body[0] : null;
  const cells = header ? body.slice(1) : body;
  return (
    <div key={keyBase} className="my-2 overflow-x-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-[10.5px] leading-relaxed">
        {header && (
          <thead>
            <tr className="border-b border-zinc-800 text-left text-zinc-400">
              {header.map((c, ci) => (
                <th key={ci} className="px-2 py-1.5 font-semibold">
                  {inline(c, `${keyBase}-h${ci}`)}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {cells.map((r, ri) => (
            <tr key={ri} className="border-b border-zinc-800/50 align-top">
              {r.map((c, ci) => (
                <td key={ci} className={`px-2 py-1.5 ${ci === 0 ? "text-zinc-300" : "text-zinc-400"}`}>
                  {inline(c, `${keyBase}-${ri}-${ci}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function list(lines: string[], keyBase: string): React.ReactNode {
  type Item = { depth: number; ordered: boolean; text: string };
  const items: Item[] = lines.map((l) => {
    const m = l.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    return { depth: Math.floor((m?.[1].length ?? 0) / 2), ordered: /^\d/.test(m?.[2] ?? ""), text: m?.[3] ?? l };
  });
  // flat rendering with per-depth bullets — one nesting level, enough for the docs
  const render = (from: number, depth: number, key: string): React.ReactNode[] => {
    const nodes: React.ReactNode[] = [];
    const Tag = items[from]?.ordered ? "ol" : "ul";
    const cls = items[from]?.ordered ? "list-decimal" : "list-disc";
    const children: React.ReactNode[] = [];
    let i = from;
    while (i < items.length && items[i].depth >= depth) {
      if (items[i].depth > depth) {
        children.push(<div key={`${key}-n${i}`}>{render(i, items[i].depth, `${key}-n${i}`)}</div>);
        while (i < items.length && items[i].depth > depth) i++;
        continue;
      }
      children.push(
        <li key={`${key}-${i}`} className="text-zinc-400">
          {inline(items[i].text, `${key}-t${i}`)}
        </li>,
      );
      i++;
    }
    nodes.push(
      <Tag key={key} className={`${cls} my-1.5 space-y-1 pl-5 text-xs leading-relaxed`}>
        {children}
      </Tag>,
    );
    return nodes;
  };
  return <>{render(0, items[0]?.depth ?? 0, keyBase)}</>;
}

/** the whole doc → JSX blocks */
export default function Markdown({ md }: { md: string }): React.ReactNode {
  const lines = md.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const key = `b${k++}`;
    const line = lines[i];
    // fenced code
    if (line.trim().startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre key={key} className="my-2 overflow-x-auto rounded border border-zinc-800 bg-zinc-950/80 px-3 py-2 font-mono text-[10px] leading-relaxed text-zinc-300">
          {buf.join("\n")}
        </pre>,
      );
      continue;
    }
    // headings
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      const text = h[2];
      if (lvl === 1) {
        blocks.push(
          <h2 key={key} className="mt-3 mb-1 text-sm font-bold text-zinc-100">
            {inline(text, key)}
          </h2>,
        );
      } else if (lvl === 2) {
        blocks.push(
          <h3 key={key} className="mt-3 mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-200">
            {inline(text, key)}
          </h3>,
        );
      } else {
        blocks.push(
          <h4 key={key} className="mt-2 mb-1 text-xs font-semibold text-zinc-300">
            {inline(text, key)}
          </h4>,
        );
      }
      i++;
      continue;
    }
    // hr
    if (/^\s*-{3,}\s*$/.test(line)) {
      blocks.push(<hr key={key} className="my-3 border-zinc-800" />);
      i++;
      continue;
    }
    // blockquote
    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={key} className="my-2 border-l-2 border-zinc-700 pl-3 text-[11px] italic leading-relaxed text-zinc-400">
          {inline(buf.join(" "), key)}
        </blockquote>,
      );
      continue;
    }
    // table
    if (line.trim().startsWith("|")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push(table(buf, key));
      continue;
    }
    // list
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push(list(buf, key));
      continue;
    }
    // paragraph
    if (line.trim() === "") {
      i++;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,4}\s|```|>|\||\s*([-*]|\d+\.)\s|\s*-{3,}\s*$)/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key} className="my-1.5 text-xs leading-relaxed text-zinc-400">
        {inline(buf.join(" "), key)}
      </p>,
    );
  }
  return <div className="text-left">{blocks}</div>;
}
