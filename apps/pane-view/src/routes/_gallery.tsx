import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSessionStatus } from "@/features/auth/session-service";
import { GalleryLayout } from "@/features/gallery/GalleryLayout";

export const Route = createFileRoute("/_gallery")({
  ssr: false,
  loader: async () => {
    const { authenticated } = await getSessionStatus();
    if (!authenticated) {
      throw redirect({ to: "/login" });
    }
  },
  component: GalleryLayout,
});
