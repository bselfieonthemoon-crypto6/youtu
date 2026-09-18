"use client";

import { motion } from "framer-motion";
import React from "react";

type ThinkingBlockViewProps = {
  thinking: string;
  isStreaming: boolean;
};

/**
 * Thinking text is retained in message data for continuity and audit, while
 * the customer UI exposes only a compact lifecycle status.
 */
export const ThinkingBlockView = React.memo(function ThinkingBlockView({
  isStreaming,
}: ThinkingBlockViewProps) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="mb-2 flex items-center gap-2 text-xs text-muted-foreground/70"
      role={isStreaming ? "status" : undefined}
      aria-live={isStreaming ? "polite" : undefined}
    >
      <span aria-hidden="true">{isStreaming ? "◌" : "✓"}</span>
      <span>{isStreaming ? "正在分析中" : "分析完成"}</span>
    </motion.div>
  );
});
