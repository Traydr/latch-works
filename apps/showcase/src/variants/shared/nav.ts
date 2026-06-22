export function navClass(pathname: string, href: string, end = false): string {
  const active = end ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return [
    "rounded-md px-3 py-2 text-sm transition",
    active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
  ].join(" ");
}
