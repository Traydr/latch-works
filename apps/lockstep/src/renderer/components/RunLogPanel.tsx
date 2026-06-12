interface RunLogPanelProps {
  logs: string[];
}

export function RunLogPanel({ logs }: RunLogPanelProps) {
  return (
    <div className="max-h-72 overflow-auto rounded-2xl border border-zinc-800/80 bg-zinc-950 px-4 py-3 font-mono text-xs leading-relaxed text-zinc-200">
      {logs.length > 0 ? logs.join("\n") : "Waiting for output..."}
    </div>
  );
}
