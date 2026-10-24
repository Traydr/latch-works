import { CheckCircle2, XCircle } from "lucide-react";

import type { DoctorResult } from "../../shared/types";

interface DoctorCheckListProps {
  result: DoctorResult;
}

/** The connection check's results, one row each, in a card. */
export function DoctorCheckList({ result }: DoctorCheckListProps) {
  return (
    <ul className="lw-card divide-y lw-divider">
      {result.checks.map((check) => (
        <li key={check.label} className="flex items-start gap-2.5 px-4 py-2.5">
          {check.ok ? (
            <CheckCircle2
              className="mt-px size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
          ) : (
            <XCircle className="mt-px size-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
          )}
          <div className="min-w-0">
            <p className="text-[13px] font-medium">{check.label}</p>
            <p className="lw-caption">
              {check.ok ? "Passed" : "Failed"}
              {check.detail ? ` · ${check.detail}` : ""}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
