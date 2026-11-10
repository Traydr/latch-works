import type { PageLocation } from "./collector-entry";

/** Page helpers every collector reads with; collectors may share this module but not each other. */

export function getText(element: Element | null): string {
  return element?.textContent?.trim() ?? "";
}

/** A page-relative URL resolved against the page; null when there is none. */
export function resolveUrl(
  value: string | null | undefined,
  location: PageLocation,
): string | null {
  return value ? new URL(value, location.href).toString() : null;
}

/** The URL a lazy-loaded image will show. */
export function getImageSource(image: HTMLImageElement, location: PageLocation): string | null {
  return resolveUrl(image.getAttribute("data-src") || image.getAttribute("src"), location);
}
