export function requireElement<T extends HTMLElement>(
  document: Document,
  id: string,
  elementType: new () => T,
): T {
  const element = document.getElementById(id);

  if (!(element instanceof elementType)) {
    throw new Error(`Missing required element: ${id}`);
  }

  return element;
}
