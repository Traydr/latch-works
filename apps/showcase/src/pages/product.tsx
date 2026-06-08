import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft, Check } from "lucide-react";
import { getProduct } from "@/data/products";
import { FeatureIcon, ProductBadge, Screenshot, SectionHeading } from "@/components/ui";

export function ProductPage() {
  const { slug } = useParams();
  const product = slug ? getProduct(slug) : undefined;

  if (!product) {
    return <Navigate to="/" replace />;
  }

  return (
    <>
      <section className={`relative overflow-hidden border-b border-border/70 bg-gradient-to-br ${product.accent}`}>
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <Link
            to="/"
            className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground transition hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to overview
          </Link>

          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{product.name}</h1>
            <ProductBadge kind={product.kind} />
          </div>
          <p className="mt-2 text-lg text-primary">{product.tagline}</p>
          <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">{product.description}</p>
          <p className="mt-4 font-mono text-xs text-muted-foreground">{product.repoPath}</p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
        <Screenshot
          src={product.heroScreenshot.src}
          alt={product.heroScreenshot.alt}
          caption={product.heroScreenshot.caption}
          priority
        />
      </section>

      <section className="border-y border-border/70 bg-card/20">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <SectionHeading
            eyebrow="Features"
            title={`What ${product.name} does`}
            description="Real capabilities drawn from the monorepo — not aspirational marketing copy."
          />

          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {product.features.map((feature) => (
              <article
                key={feature.title}
                className="rounded-xl border border-border/70 bg-background/40 p-5 transition hover:border-primary/30"
              >
                <FeatureIcon name={feature.icon} />
                <h3 className="mt-4 font-medium text-foreground">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{feature.description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
        <SectionHeading
          eyebrow="Highlights"
          title="At a glance"
        />
        <ul className="mt-8 grid gap-3 sm:grid-cols-2">
          {product.highlights.map((item) => (
            <li
              key={item}
              className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/15 px-4 py-3 text-sm text-muted-foreground"
            >
              <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
      </section>

      {product.gallery.length > 0 ? (
        <section className="border-t border-border/70 bg-card/20">
          <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
            <SectionHeading eyebrow="Screenshots" title="More from the app" />
            <div className="mt-10 grid gap-8 lg:grid-cols-2">
              {product.gallery.map((shot) => (
                <Screenshot key={shot.src} src={shot.src} alt={shot.alt} caption={shot.caption} />
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
