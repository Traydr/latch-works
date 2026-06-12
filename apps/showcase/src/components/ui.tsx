import {
  Activity,
  ArrowRight,
  Blocks,
  BookOpen,
  Film,
  FolderInput,
  FolderTree,
  GitCompare,
  Globe,
  HardDrive,
  Images,
  Keyboard,
  LayoutGrid,
  ListChecks,
  MessagesSquare,
  Play,
  RefreshCw,
  Search,
  Shield,
  Smartphone,
  Stethoscope,
  Upload,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";

const iconMap: Record<string, LucideIcon> = {
  activity: Activity,
  blocks: Blocks,
  "book-open": BookOpen,
  film: Film,
  "folder-input": FolderInput,
  "folder-tree": FolderTree,
  "git-compare": GitCompare,
  globe: Globe,
  "hard-drive": HardDrive,
  images: Images,
  keyboard: Keyboard,
  "layout-grid": LayoutGrid,
  "list-checks": ListChecks,
  "messages-square": MessagesSquare,
  play: Play,
  "refresh-cw": RefreshCw,
  search: Search,
  shield: Shield,
  smartphone: Smartphone,
  stethoscope: Stethoscope,
  upload: Upload,
  workflow: Workflow,
  zap: Zap,
};

export function FeatureIcon({ name }: { name: string }) {
  const Icon = iconMap[name] ?? Blocks;
  return (
    <div className="feature-icon flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60">
      <Icon className="size-5 text-primary" aria-hidden="true" />
    </div>
  );
}

export function ProductBadge({ kind }: { kind: "app" | "tool" }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border/80 bg-muted/60 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {kind}
    </span>
  );
}

export function Screenshot({
  src,
  alt,
  caption,
  priority = false,
}: {
  src: string;
  alt: string;
  caption?: string;
  priority?: boolean;
}) {
  return (
    <figure className="group">
      <div className="screenshot-frame overflow-hidden rounded-xl bg-card">
        <img
          src={src}
          alt={alt}
          loading={priority ? "eager" : "lazy"}
          className="block w-full bg-muted/30 object-cover object-top transition duration-500 group-hover:scale-[1.01]"
        />
      </div>
      {caption ? <figcaption className="mt-3 text-sm text-muted-foreground">{caption}</figcaption> : null}
    </figure>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="max-w-2xl">
      {eyebrow ? (
        <p className="mb-2 text-sm font-medium uppercase tracking-widest text-primary">{eyebrow}</p>
      ) : null}
      <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{title}</h2>
      {description ? (
        <p className="mt-3 text-base leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

export function CtaLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <a
      href={to}
      className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
    >
      {children}
      <ArrowRight className="size-4" aria-hidden="true" />
    </a>
  );
}
