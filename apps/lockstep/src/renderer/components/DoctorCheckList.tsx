import { CheckCircle2, XCircle } from "lucide-react";

import type { DoctorResult } from "../../shared/types";

interface DoctorCheckListProps {
  result: DoctorResult;
}

export function DoctorCheckList({ result }: DoctorCheckListProps) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {result.checks.map((check) => (
        <div
          key={check.label}
          className="flex items-start gap-2 rounded-xl border border-zinc-300/70 bg-white/60 px-3 py-2 dark:border-zinc-700/70 dark:bg-zinc-950/40"
        >
          {check.ok ? (
            <CheckCircle2 className="mt-0.5 size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
          ) : (
            <XCircle className="mt-0.5 size-4 text-red-600 dark:text-red-400" aria-hidden />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium">{check.label}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {check.ok ? "ok" : "failed"}
              {check.detail ? ` · ${check.detail}` : ""}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
