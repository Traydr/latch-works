import { Skeleton } from "@/components/ui/skeleton";

export function GalleryPending() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <Skeleton className="h-8 w-8 rounded-md" />
        <Skeleton className="h-4 w-48" />
        <div className="ml-auto hidden gap-2 md:flex">
          <Skeleton className="h-9 w-72" />
        </div>
      </div>
      <div className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 overflow-hidden p-5 pb-28">
        {Array.from({ length: 12 }, (_, index) => (
          <Skeleton key={index} className="aspect-[4/5] w-full rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
