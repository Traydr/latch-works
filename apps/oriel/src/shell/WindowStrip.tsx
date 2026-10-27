import orielIcon from "../../media/oriel-icon.svg";

import { useShell } from "./shell";

/**
 * The sidebar's top strip, which moves the window. macOS draws its window buttons there; with
 * Windows' at the other end, it carries the app's name, as T3 Code's does.
 */
export function WindowStrip({ rail }: { rail: boolean }) {
  const { insetTitleBar } = useShell();

  return (
    <div
      className={`lw-drag flex h-[52px] w-full shrink-0 items-center gap-2 ${
        rail ? "justify-center" : "px-4"
      }`}
    >
      {insetTitleBar ? null : (
        <>
          <img src={orielIcon} alt="" className="size-5 shrink-0" draggable={false} />
          {rail ? null : <span className="text-[13px] font-semibold">Oriel</span>}
        </>
      )}
    </div>
  );
}
