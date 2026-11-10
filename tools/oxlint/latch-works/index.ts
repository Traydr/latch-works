import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";

interface StaticImportOptions {
  message: string;
  patterns: string[];
}

/**
 * Forbids static imports (and re-exports) whose specifier matches a pattern, while dynamic
 * `import()` stays allowed. Oxlint's `no-restricted-imports` matches both.
 */
const noStaticImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow static imports matching a pattern; a dynamic import() may load them.",
    },
    messages: { staticImport: "`{{source}}` must not be imported statically. {{message}}" },
    schema: [
      {
        type: "object",
        properties: {
          message: { type: "string" },
          patterns: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["message", "patterns"],
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    // SAFETY: Oxlint validates the options against `meta.schema` before the rule runs.
    const [{ message, patterns }] = context.options as readonly [StaticImportOptions];
    const forbidden = patterns.map((pattern) => new RegExp(pattern));

    const check = (source: { value: string } | null) => {
      if (source === null || !forbidden.some((pattern) => pattern.test(source.value))) return;

      context.report({
        node: source,
        messageId: "staticImport",
        data: { message, source: source.value },
      });
    };

    return {
      ExportAllDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ImportDeclaration: (node) => check(node.source),
    };
  },
});

/** This repository's own Oxlint rules. */
export default eslintCompatPlugin({
  meta: { name: "latch-works" },
  rules: { "no-static-imports": noStaticImportsRule },
});
