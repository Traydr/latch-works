export type VariantId = "1" | "2" | "3" | "4" | "5";

export type VariantMeta = {
  id: VariantId;
  label: string;
  name: string;
  description: string;
};

export const variants: VariantMeta[] = [
  {
    id: "1",
    label: "1",
    name: "Classic",
    description: "Original calm workshop layout — top nav, card grids",
  },
  {
    id: "2",
    label: "2",
    name: "Sidebar",
    description: "Desktop-app shell with fixed left rail navigation",
  },
  {
    id: "3",
    label: "3",
    name: "Carousel",
    description: "Full-viewport hero with horizontal snap-scroll app panels",
  },
  {
    id: "4",
    label: "4",
    name: "Bento",
    description: "Asymmetric mosaic grid with mixed tile sizes",
  },
  {
    id: "5",
    label: "5",
    name: "Manifesto",
    description: "Narrow editorial column with full-bleed app chapters",
  },
];

export const defaultVariant: VariantId = "1";

export const variantStorageKey = "latch-showcase-variant";
