const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export interface NamedPath {
  name: string;
  path: string;
}

export function compareByName(a: NamedPath, b: NamedPath) {
  const byName = nameCollator.compare(a.name, b.name);

  if (byName !== 0) {
    return byName;
  }

  return nameCollator.compare(a.path, b.path);
}
