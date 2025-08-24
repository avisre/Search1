import React from "react";
import { motion } from "framer-motion";

export default function SkeletonThinking({ label = "Working…" }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.25 }}
      className="rounded-2xl p-[1px] bg-gradient-to-r from-purple-500/30 via-sky-500/25 to-emerald-500/30">
      <div className="rounded-2xl bg-slate-900/60 p-5">
        <div className="animate-pulse space-y-3">
          <div className="h-3 w-2/3 rounded bg-slate-700/50" />
          <div className="h-3 w-5/6 rounded bg-slate-700/40" />
          <div className="h-3 w-3/5 rounded bg-slate-700/30" />
          <div className="h-3 w-4/5 rounded bg-slate-700/40" />
        </div>
        <div className="mt-3 text-xs text-slate-300/80">{label}</div>
      </div>
    </motion.div>
  );
}
