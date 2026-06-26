interface RunLogPanelProps {
  compact?: boolean;
  logs: string[];
}

export function RunLogPanel({ compact = false, logs }: RunLogPanelProps) {
  return (
    <div
      className={`overflow-auto rounded-xl border border-zinc-800/80 bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-zinc-200 ${
        compact ? "max-h-40" : "h-48"
      }`}
    >
      {logs.length > 0 ? logs.join("\n") : "Waiting for output..."}
    </div>
  );
}
