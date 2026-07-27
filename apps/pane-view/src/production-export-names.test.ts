import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = join(import.meta.dirname);
const forbiddenExportName = /^(?:__.*|.*ForTests|.*TestHooks)$/u;

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSourceFiles(path);
    if (![".ts", ".tsx"].includes(extname(entry.name))) return [];
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) return [];
    return [path];
  });
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

/** Resolves a relative specifier to a source file, mirroring TS resolution. */
function resolveRelativeModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;

  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/u, ""));
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function exportedNames(file: string, visited: Set<string> = new Set()): string[] {
  if (visited.has(file)) return [];
  visited.add(file);

  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const names: string[] = [];

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause) {
        if (ts.isNamedExports(statement.exportClause)) {
          names.push(...statement.exportClause.elements.map((element) => element.name.text));
        }
        continue;
      }

      // `export * from "./x"` forwards every name in the target, so the target
      // has to be inspected too — otherwise a star re-export launders a
      // forbidden export straight through this gate.
      const specifier = statement.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) {
        const target = resolveRelativeModule(file, specifier.text);
        if (target) names.push(...exportedNames(target, visited));
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;

    if (ts.isVariableStatement(statement)) {
      names.push(
        ...statement.declarationList.declarations.flatMap((declaration) =>
          bindingNames(declaration.name),
        ),
      );
      continue;
    }

    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
    }
  }

  return names;
}

describe("production export names", () => {
  it("does not expose test-only identifiers from Pane View source modules", () => {
    const offenders = productionSourceFiles(sourceRoot).flatMap((file) =>
      exportedNames(file)
        .filter((name) => forbiddenExportName.test(name))
        .map((name) => `${relative(sourceRoot, file)}: ${name}`),
    );

    expect(offenders, `Forbidden production exports:\n${offenders.join("\n")}`).toEqual([]);
  });
});
