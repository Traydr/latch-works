/**
 * PROTOTYPE — throwaway. Do not ship.
 *
 * Question: "What should the showcase look like?"
 * Iteration 3: five design FAMILIES, each expressed on the index and all four
 * product pages. Variant keys are aligned across routes — `?variant=3` on `/`
 * and on `/pane-view` is the same family — so a full set can be evaluated as
 * one coherent system. Key 0 is always the current design.
 */
export type VariantOption = {
  key: string;
  name: string;
  slug: string;
};

export const PROTOTYPE_FAMILY_COOKIE = "latch-works.prototype-family";

export const FAMILIES: VariantOption[] = [
  { key: "0", name: "Current", slug: "current" },
  { key: "1", name: "Archive", slug: "archive" },
  { key: "2", name: "Workshop", slug: "workshop" },
  { key: "3", name: "Atlas", slug: "atlas" },
  { key: "4", name: "Dossier", slug: "dossier" },
  { key: "5", name: "Pigment", slug: "pigment" },
  { key: "6", name: "Colorblock", slug: "colorblock" },
  { key: "7", name: "Blueprint", slug: "blueprint" },
  { key: "8", name: "Riso", slug: "riso" },
  { key: "9", name: "Halftone", slug: "halftone" },
  { key: "10", name: "Swatchbook", slug: "swatchbook" },
];

export const HOME_VARIANTS = FAMILIES;
export const PRODUCT_VARIANTS = FAMILIES;

export function resolveVariant(param: string | null, options: VariantOption[]): VariantOption {
  return options.find((v) => v.key === param || v.slug === param) ?? options[0];
}
