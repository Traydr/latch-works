import { Skeleton } from "@/components/ui/skeleton";

export function GalleryGridSkeleton() {
  return (
    <div className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 overflow-hidden p-5 pb-28">
      {Array.from({ length: 12 }, (_, index) => (
        <Skeleton key={index} className="aspect-[4/5] w-full rounded-2xl" />
      ))}
    </div>
  );
}
