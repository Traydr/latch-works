import { ChevronLeft } from "lucide-react";
import { type JSX, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { GalleryMedia } from "@/features/library/listing-contract";
import { originalUrl } from "./original-url";

export type OriginalItem = Pick<GalleryMedia, "id" | "mediaType" | "name">;

/**
 * An original file shown inside the installed app (plan 066, D3). It opens over whatever asked
 * for it, the viewer included, so Back returns to that exact state: the same item, the same
 * video position. The original route checks the session itself.
 */
export function OriginalDialog({
  item,
  onClose,
}: {
  item: OriginalItem;
  onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // A modal dialog joins the top layer, above the viewer's own modal dialog.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;

    if (dialog && !dialog.open) dialog.showModal();

    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-label={`Original of ${item.name}`}
      className="dark pointer-events-auto fixed inset-0 z-50 m-0 flex h-dvh max-h-none w-screen max-w-none flex-col border-y-0 border-r-(length:--safe-area-right) border-l-(length:--safe-area-left) border-transparent bg-zinc-950 p-0 text-zinc-100"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // The viewer and the gallery listen for keys on the window; under this dialog they must not
      // step, close or move focus.
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2 pt-[max(0.5rem,var(--safe-area-top))]">
        <Button className="gap-1" onClick={onClose} type="button" variant="ghost">
          <ChevronLeft />
          <span>Back</span>
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{item.name}</h2>
      </header>
      <div className="min-h-0 flex-1 pb-(--safe-area-bottom)">
        <OriginalFile item={item} />
      </div>
    </dialog>
  );
}

function OriginalFile({ item }: { item: OriginalItem }): JSX.Element {
  const src = originalUrl(item.id);

  switch (item.mediaType) {
    case "image":
    case "gif":
      return (
        <div className="grid h-full place-items-center overflow-auto p-2">
          <img alt={item.name} className="max-h-full max-w-full object-contain" src={src} />
        </div>
      );
    case "video":
      return (
        // biome-ignore lint/a11y/useMediaCaption: caption sidecars are not ingested yet.
        <video className="h-full w-full bg-black" controls playsInline src={src} />
      );
    case "pdf":
    case "unknown":
      return <iframe className="h-full w-full border-0 bg-white" src={src} title={item.name} />;
    default: {
      const _exhaustive: never = item.mediaType;

      return _exhaustive;
    }
  }
}
