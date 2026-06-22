import { useEffect, useState } from "react";
import { defaultVariant, variantStorageKey, variants, type VariantId } from "@/data/variants";

function applyVariant(id: VariantId) {
  document.documentElement.dataset.activeVariant = id;
  localStorage.setItem(variantStorageKey, id);
}

export function VariantSwitcher() {
  const [active, setActive] = useState<VariantId>(defaultVariant);

  useEffect(() => {
    const stored = localStorage.getItem(variantStorageKey) as VariantId | null;
    const initial =
      stored && variants.some((variant) => variant.id === stored) ? stored : defaultVariant;
    setActive(initial);
    applyVariant(initial);
  }, []);

  function selectVariant(id: VariantId) {
    setActive(id);
    applyVariant(id);
  }

  return (
    <nav
      className="fixed right-0 top-1/2 z-[100] flex -translate-y-1/2 flex-col rounded-l-lg border border-border/80 bg-card/95 shadow-lg backdrop-blur-md"
      aria-label="Layout variant switcher"
    >
      {variants.map((variant) => {
        const isActive = active === variant.id;
        return (
          <button
            key={variant.id}
            type="button"
            onClick={() => selectVariant(variant.id)}
            title={`${variant.name}: ${variant.description}`}
            aria-label={`Switch to layout ${variant.label}: ${variant.name}`}
            aria-pressed={isActive}
            className={[
              "group relative flex h-11 w-11 items-center justify-center text-sm font-semibold transition",
              "border-b border-border/50 last:border-b-0",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            ].join(" ")}
          >
            {variant.label}
            <span className="pointer-events-none absolute right-full mr-2 hidden whitespace-nowrap rounded border border-border bg-card px-2 py-1 text-xs font-normal text-foreground group-hover:block">
              {variant.name}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
