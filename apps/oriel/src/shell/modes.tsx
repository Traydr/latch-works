import type { ComponentType } from "react";

import { MODE_LABELS, type ModeId } from "../shared/shell";
import { ModeLayout } from "./ModeLayout";

/** A mode whose app has not moved in yet. */
function placeholder(id: ModeId, from: string): ComponentType {
  function Placeholder() {
    return (
      <ModeLayout>
        <div className="gz-drag h-[52px] shrink-0" />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 pb-[100px] text-center">
          <p className="text-[15px] font-semibold">{MODE_LABELS[id]}</p>
          <p className="max-w-sm text-[13px] text-zinc-500 dark:text-zinc-400">
            {from} moves in here.
          </p>
        </div>
      </ModeLayout>
    );
  }

  return Placeholder;
}

/** Each mode's whole window, inside a {@link ModeLayout}. */
export const MODE_ROOTS = {
  view: placeholder("view", "Frame View"),
  tidy: placeholder("tidy", "Glazier"),
  sync: placeholder("sync", "Lockstep"),
} satisfies Record<ModeId, ComponentType>;
