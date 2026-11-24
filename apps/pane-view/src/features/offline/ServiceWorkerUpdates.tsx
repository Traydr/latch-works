import { RefreshCw } from "lucide-react";
import { type JSX, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { serviceWorkerSupported, serviceWorkerUrl } from "./service-worker";

/**
 * Registers the service worker after the first render, and offers a reload when a new build's
 * worker is waiting. The new worker takes over only when the owner presses Reload, so a page
 * never runs against another build's assets.
 */
export function ServiceWorkerUpdates(): JSX.Element | null {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const reloadRequested = useRef(false);

  useEffect(() => {
    if (!serviceWorkerSupported()) return;

    const container = navigator.serviceWorker;

    // Only an update waits: the first worker has no page to take over from, so it never asks.
    const offerWhenInstalled = (worker: ServiceWorker) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && container.controller) setWaiting(worker);
      });
    };

    const onControllerChange = () => {
      if (reloadRequested.current) window.location.reload();
    };

    container.addEventListener("controllerchange", onControllerChange);

    container
      .register(serviceWorkerUrl(), { scope: "/" })
      .then((registration) => {
        if (registration.waiting && container.controller) setWaiting(registration.waiting);

        if (registration.installing) offerWhenInstalled(registration.installing);

        registration.addEventListener("updatefound", () => {
          if (registration.installing) offerWhenInstalled(registration.installing);
        });
      })
      .catch((error: Error) => {
        console.warn("[pane-view] Unable to register the service worker", error);
      });

    return () => container.removeEventListener("controllerchange", onControllerChange);
  }, []);

  if (waiting === null) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(5.5rem+var(--safe-area-bottom))] z-40 flex justify-center px-4">
      <div
        className="pointer-events-auto flex items-center gap-3 rounded-xl bg-popover py-1.5 pr-1.5 pl-4 text-sm text-popover-foreground shadow-float"
        role="status"
      >
        <span>Update available</span>
        <Button
          className="gap-1.5"
          onClick={() => {
            reloadRequested.current = true;
            waiting.postMessage({ type: "skip-waiting" });
          }}
          size="sm"
          type="button"
        >
          <RefreshCw />
          Reload
        </Button>
      </div>
    </div>
  );
}
