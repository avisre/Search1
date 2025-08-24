import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Linkify [n] -> [n](url) and soften unsupported marker
function normalizeMarkdown(md, citations) {
  if (!md) return "";
  const linked = md.replace(/\[(\d+)\]/g, (m, n) => {
    const i = parseInt(n, 10) - 1;
    const url = citations?.[i] || "";
    return url ? `[${n}](${url})` : m;
  });
  return linked.replace(
    /_\((?:not supported by the provided sources)\)_/gi,
    "**⚠︎ unverified**"
  );
}

// “Quick take” = first sentence or first ~180 chars
function quickTake(md) {
  if (!md) return "";
  const plain = md.replace(/\s+/g, " ").trim();
  const m = plain.match(/^(.{40,220}?[.!?])\s/);
  return (m ? m[1] : plain.slice(0, 220)).trim();
}

export default function ClaudeAnswer({ content = "", citations = [], asOf, onCopy }) {
  const pretty = useMemo(() => normalizeMarkdown(content, citations), [content, citations]);
  const take = useMemo(() => quickTake(content), [content]);

  return (
    <div className="max-w-3xl rounded-2xl overflow-hidden border border-black/5 bg-stone-50 text-stone-900 shadow-sm">
      {/* toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-stone-200 bg-stone-50/70">
        <div className="text-xs text-stone-500">Answer</div>
        <div className="flex items-center gap-2">
          {asOf && (
            <span className="px-2 py-1 rounded-full text-[11px] bg-stone-100 border border-stone-200 text-stone-600">
              As of {asOf}
            </span>
          )}
          <button
            onClick={onCopy}
            className="text-xs px-2 py-1 rounded-md bg-white border border-stone-200 text-stone-700 hover:bg-stone-100 transition"
          >
            Copy
          </button>
        </div>
      </div>

      {/* summary callout (Claude-style) */}
      {take && (
        <div className="px-4 pt-3">
          <div className="rounded-md border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700">
            <span className="font-semibold text-stone-800">Summary: </span>
            {take}
          </div>
        </div>
      )}

      {/* main document */}
      <div className="px-5 py-4">
        <div
          className="
            prose prose-claude max-w-none
            prose-headings:font-serif prose-h2:mt-5 prose-h2:mb-2 prose-h3:mt-4 prose-h3:mb-1
            prose-li:my-1 prose-ul:mt-2 prose-ol:mt-2
            prose-strong:text-stone-900
            prose-a:text-sky-700 hover:prose-a:text-sky-600
          "
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{pretty}</ReactMarkdown>
        </div>

        {/* sources row like Claude */}
        {citations?.length > 0 && (
          <div className="mt-4 text-sm">
            <span className="text-stone-500 mr-2">Sources:</span>
            {citations.map((u, i) => (
              <a
                key={u + i}
                href={u}
                target="_blank"
                rel="noreferrer"
                className="underline text-sky-700 hover:text-sky-600 mr-3"
                title={u}
              >
                [source {i + 1}]
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
