import { createFileRoute, redirect } from "@tanstack/react-router";
import { GalleryLayout } from "@/features/gallery/GalleryLayout";
import { isCurrentWebSessionValid } from "@/server/auth/web-session";

export const Route = createFileRoute("/_gallery")({
  beforeLoad: async () => {
    if (!(await isCurrentWebSessionValid())) {
      throw redirect({ to: "/login" });
    }
  },
  component: GalleryLayout,
});
