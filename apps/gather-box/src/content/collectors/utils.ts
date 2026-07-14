export function getText(element: Element | null): string {
  return element ? element.textContent?.trim() || "" : "";
}

export function getFileName(originalUrl: string): string {
  const url = new URL(originalUrl);
  const parts = url.pathname.split("/");
  return parts[parts.length - 1] || "image";
}

export function getImageSource(image: HTMLImageElement, location: Location): string | null {
  const rawSource = image.getAttribute("data-src") || image.getAttribute("src");
  if (!rawSource) {
    return null;
  }

  return new URL(rawSource, location.href).toString();
}
