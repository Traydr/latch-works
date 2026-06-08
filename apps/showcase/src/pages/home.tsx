import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { pipeline, products } from "@/data/products";
import { ProductBadge, SectionHeading } from "@/components/ui";

export function HomePage() {
  return (
    <>
      <section className="gradient-grid relative overflow-hidden border-b border-border/70">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,color-mix(in_oklch,var(--primary)_18%,transparent),transparent_60%)]" />
        <div className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <p className="mb-4 text-sm font-medium uppercase tracking-widest text-primary">
            Private media archive ecosystem
          </p>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
            Collect, sync, and view your archive — privately.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            Latch Works brings together a browser extension, desktop viewer, sync CLI, and web viewer
            into one calm, local-first system. Your laptop stays the source of truth; remote access is
            explicit and authenticated.
          </p>

          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {pipeline.map((stage) => (
              <div key={stage.step} className="glass-panel rounded-xl p-4">
                <p className="text-xs font-medium uppercase tracking-widest text-primary">{stage.step}</p>
                <p className="mt-1 font-medium text-foreground">{stage.product}</p>
                <p className="mt-2 text-sm text-muted-foreground">{stage.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <SectionHeading
          eyebrow="Apps"
          title="Three surfaces, one archive"
          description="Each app handles a distinct part of the workflow — collection, local browsing, and private web viewing."
        />

        <div className="mt-10 grid gap-6 lg:grid-cols-3">
          {products
            .filter((product) => product.kind === "app")
            .map((product) => (
              <Link
                key={product.slug}
                to={`/${product.slug}`}
                className={`group glass-panel overflow-hidden rounded-2xl transition hover:border-primary/40 hover:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_30%,transparent)]`}
              >
                <div className={`h-1.5 bg-gradient-to-r ${product.accent}`} />
                <div className="overflow-hidden">
                  <img
                    src={product.heroScreenshot.src}
                    alt={product.heroScreenshot.alt}
                    className="aspect-[16/10] w-full object-cover object-top transition duration-500 group-hover:scale-[1.02]"
                  />
                </div>
                <div className="p-5">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-lg font-semibold text-foreground">{product.name}</h3>
                    <ProductBadge kind={product.kind} />
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{product.tagline}</p>
                  <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary">
                    Explore features
                    <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
                  </span>
                </div>
              </Link>
            ))}
        </div>
      </section>

      <section className="border-y border-border/70 bg-card/30">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <SectionHeading
            eyebrow="Tools"
            title="Explicit sync, no surprises"
            description="Lockstep is the controlled bridge between your local archive and the hosted Pane View backend."
          />

          {products
            .filter((product) => product.kind === "tool")
            .map((product) => (
              <Link
                key={product.slug}
                to={`/${product.slug}`}
                className="group mt-10 grid overflow-hidden rounded-2xl border border-border/80 bg-card/60 lg:grid-cols-2"
              >
                <div className="overflow-hidden">
                  <img
                    src={product.heroScreenshot.src}
                    alt={product.heroScreenshot.alt}
                    className="h-full min-h-[240px] w-full object-cover object-left-top transition duration-500 group-hover:scale-[1.01]"
                  />
                </div>
                <div className="flex flex-col justify-center p-8">
                  <div className="flex items-center gap-3">
                    <h3 className="text-2xl font-semibold text-foreground">{product.name}</h3>
                    <ProductBadge kind={product.kind} />
                  </div>
                  <p className="mt-3 text-base leading-relaxed text-muted-foreground">{product.description}</p>
                  <ul className="mt-6 space-y-2">
                    {product.highlights.slice(0, 3).map((item) => (
                      <li key={item} className="flex gap-2 text-sm text-muted-foreground">
                        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                        {item}
                      </li>
                    ))}
                  </ul>
                  <span className="mt-6 inline-flex items-center gap-1 text-sm font-medium text-primary">
                    View Lockstep features
                    <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
                  </span>
                </div>
              </Link>
            ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <SectionHeading
          eyebrow="Principles"
          title="Built for personal archives"
          description="Latch Works is intentionally read-focused. It is not a social platform or a public gallery."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { title: "Local-first", body: "The archive on disk stays authoritative. Sync is explicit, never automatic mirroring." },
            { title: "Private by default", body: "Web viewing requires authentication. Delivery URLs are signed and time-limited." },
            { title: "Shared packages", body: "media-domain, media-index, media-storage, and media-delivery keep behavior consistent." },
            { title: "Calm tooling", body: "Direct language, dark UI, practical spacing — a workshop, not a marketing site." },
          ].map((item) => (
            <div key={item.title} className="rounded-xl border border-border/70 bg-muted/20 p-5">
              <h3 className="font-medium text-foreground">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
