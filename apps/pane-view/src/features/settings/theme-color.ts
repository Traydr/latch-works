/**
 * The page background of each resolved theme (`--background` in styles.css). An installed app's
 * status bar takes this colour from the `theme-color` meta, so it must match the page under it.
 */
export const THEME_COLORS = { dark: "#09090b", light: "#ffffff" } as const;

/** The `theme-color` metas the document starts with: one per system colour scheme. */
export const THEME_COLOR_METAS = [
  { content: THEME_COLORS.light, media: "(prefers-color-scheme: light)", name: "theme-color" },
  { content: THEME_COLORS.dark, media: "(prefers-color-scheme: dark)", name: "theme-color" },
] as const;
