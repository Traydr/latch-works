import { createFileRoute } from "@tanstack/react-router";
import { GalleryLayout } from "@/features/gallery/GalleryLayout";

export const Route = createFileRoute("/_authed/_gallery")({
  component: GalleryLayout,
});
