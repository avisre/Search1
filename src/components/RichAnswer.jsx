import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion } from "framer-motion";
import cn from "classnames";

// map [1]..[n] in markdown to real links & prettify warnings
function transformMarkdown(md, citations) {
  if (!md) return "";
  const linked = md.replace(/\[(\d+)\]/g, (m, n) => {
    const i = parseInt(n, 10) - 1;
    const url = citations?.[i] || "";
    return url ? `[${n}](${url})` : m;
  });
  return linked.replace(/_\((?:not supported by the provided sources)\)_/gi, "**⚠︎ unverified**");
}

// naive quick-take = first sentence (kept short)
function quickTake(md) {
  const plain = md.replace(/\s+/g, " ").trim();
  const m = plain.match(/^(.{40,220}?[.!?])\s/);
  return m ? m[1] : plain.slice(0, 220);
}
function host(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } }

export default function RichAnswer({ content="", citations=[], asOf, onCopy }) {
  const pretty = useMemo(() => transformMarkdown(content, citations), [content, citations]);
  const take = useMemo(() => quickTake(content), [content]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
      className="relative rounded-2xl p-[1px] bg-gradient-to-r from-fuchsia-500/40 via-sky-500/30 to-emerald-500/40 card-glow"
    >
      <div className="rounded-2xl bg-slate-900/70 backdrop-blur-xl overflow-hidden">
        {/* header */}
        <div className="flex items-center justify-between px-5 pt-4">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-emerald-400 shadow-[0_0_18px_2px_rgba(52,211,153,0.55)]" />
            <span className="text-slate-200/90 text-sm">Answer</span>
          </div>
          <div className="flex items-center gap-2">
            {asOf && (
              <span className="px-2 py-1 rounded-full text-[11px] bg-slate-800/70 text-slate-300 border border-white/10">
                As of {asOf}
              </span>
            )}
            <button
              onClick={onCopy}
              className="text-xs px-2 py-1 rounded-md bg-white/5 border border-white/10 text-slate-200 hover:bg-white/10 transition"
            >
              Copy
            </button>
          </div>
        </div>

        {/* quick take */}
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="px-5 pt-3">
          <div className="rounded-xl border border-white/10 bg-gradient-to-r from-slate-800/60 to-slate-800/30 px-4 py-3 text-sm">
            <span className="text-slate-300/90">Quick take: </span>
            <span className="text-slate-100 font-medium">{take}</span>
          </div>
        </motion.div>

        {/* main content */}
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }} className="px-5 pb-4 pt-3">
          <div className="prose prose-invert prose-sm max-w-none prose-headings:text-slate-100 prose-strong:text-slate-100 prose-a:text-sky-300 hover:prose-a:text-sky-200">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{pretty}</ReactMarkdown>
          </div>

          {/* sources */}
          {citations?.length > 0 && (
            <div className="mt-5">
              <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">Sources</div>
              <div className="flex flex-wrap gap-2">
                {citations.map((u, i) => (
                  <a
                    key={u + i}
                    href={u}
                    target="_blank"
                    rel="noreferrer"
                    className={cn("group flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full",
                                  "bg-slate-800/60 border border-white/10 hover:bg-slate-800/80 transition")}
                    title={u}
                  >
                    <img alt="" width={14} height={14} className="rounded-sm opacity-90 group-hover:opacity-100"
                         src={`https://www.google.com/s2/favicons?sz=64&domain=${host(u)}`} />
                    <span className="text-[11px] text-slate-300">[{i + 1}] {host(u)}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </motion.div>

        {/* shimmer accent */}
        <div className="answer-shine pointer-events-none" />
      </div>
    </motion.div>
  );
}
