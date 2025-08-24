import React from "react";
import { motion } from "framer-motion";

export default function AutoCorrectPill({ original, corrected, onUseOriginal, onKeep }) {
  if (!corrected || corrected === original) return null;
  return (
    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
      className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/15 border border-amber-400/30 text-amber-200 text-xs">
      <span className="font-medium">Auto-corrected</span>
      <span className="line-through opacity-70">{original}</span>
      <span className="opacity-90">→</span>
      <span className="font-medium">{corrected}</span>
      <button onClick={onUseOriginal}
        className="ml-1 px-2 py-0.5 rounded-md bg-white/10 hover:bg-white/20 transition border border-white/10" title="Use what I typed">
        Use original
      </button>
      <button onClick={onKeep}
        className="px-2 py-0.5 rounded-md bg-emerald-500/20 hover:bg-emerald-500/30 transition border border-emerald-400/30" title="Keep correction">
        Keep
      </button>
    </motion.div>
  );
}
