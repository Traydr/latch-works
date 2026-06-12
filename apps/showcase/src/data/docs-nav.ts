import type { CollectionEntry } from "astro:content";

export type DocsSection = {
  name: string;
  sectionOrder: number;
  pages: CollectionEntry<"docs">[];
};

export function groupDocsBySection(docs: CollectionEntry<"docs">[]): DocsSection[] {
  const bySection = new Map<string, DocsSection>();

  for (const doc of docs) {
    const existing = bySection.get(doc.data.section);
    if (existing) {
      existing.pages.push(doc);
      continue;
    }

    bySection.set(doc.data.section, {
      name: doc.data.section,
      sectionOrder: doc.data.sectionOrder,
      pages: [doc],
    });
  }

  return [...bySection.values()]
    .sort((left, right) => left.sectionOrder - right.sectionOrder)
    .map((section) => ({
      ...section,
      pages: section.pages.sort((left, right) => left.data.order - right.data.order),
    }));
}

export function docNavLabel(doc: CollectionEntry<"docs">): string {
  return doc.data.navTitle ?? doc.data.title;
}
