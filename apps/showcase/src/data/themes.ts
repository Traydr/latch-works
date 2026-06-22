export type ThemeId = "1" | "2" | "3" | "4" | "5";

export type ThemeMeta = {
  id: ThemeId;
  label: string;
  name: string;
  description: string;
};

export const themes: ThemeMeta[] = [
  {
    id: "1",
    label: "1",
    name: "Brutalist",
    description: "Raw concrete, monospace authority, zero-radius edges",
  },
  {
    id: "2",
    label: "2",
    name: "Neon",
    description: "Synthwave grids, electric glow, retro-futurist chrome",
  },
  {
    id: "3",
    label: "3",
    name: "Editorial",
    description: "Magazine serif drama, asymmetric columns, ink on cream",
  },
  {
    id: "4",
    label: "4",
    name: "Organic",
    description: "Earthy curves, soft terracotta, botanical calm",
  },
  {
    id: "5",
    label: "5",
    name: "Art Deco",
    description: "Geometric gold, stepped symmetry, Gatsby grandeur",
  },
];

export const defaultTheme: ThemeId = "1";

export const themeStorageKey = "latch-showcase-theme";
