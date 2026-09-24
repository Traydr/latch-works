import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { GALLERY_GRID_SCROLL_ID } from "./features/gallery/gallery-grid-scroll";
import { createQueryClient } from "./lib/query-client";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const queryClient = createQueryClient();

  return createRouter({
    routeTree,
    context: {
      queryClient,
    },
    defaultPreload: "intent",
    scrollRestoration: true,
    // The gallery grid is a scrolled element that outlives folder changes, so
    // without this a new folder inherits the old one's offset. Listed here,
    // it starts at the top on every navigation that resets scroll, while
    // Back and Forward still restore their saved offset.
    scrollToTopSelectors: [`[data-scroll-restoration-id="${GALLERY_GRID_SCROLL_ID}"]`],
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
