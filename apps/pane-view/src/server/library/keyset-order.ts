import { and, asc, desc, eq, gt, lt, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";

/**
 * One column of a paged listing's order. A listing writes its order once as
 * a list of these; the ORDER BY and the keyset condition that continues from
 * a cursor are both built from it, so they cannot drift apart (a drift makes
 * pages skip or repeat rows). The last column must make the order total.
 */
export interface KeysetColumn<Cursor> {
  direction: "asc" | "desc";
  expression: SQLWrapper;
  /** This column's value in the cursor's row. */
  cursorValue(cursor: Cursor): number | string;
}

export function keysetOrderBy<Cursor>(columns: readonly KeysetColumn<Cursor>[]): SQL[] {
  return columns.map(({ direction, expression }) =>
    direction === "asc" ? asc(expression) : desc(expression),
  );
}

/**
 * Rows strictly after the cursor's row in `columns` order, comparing each
 * column with the expression (and so the collation) the ORDER BY uses. When
 * every column sorts the same way this is one row-value comparison; mixed
 * directions expand to `a < x or (a = x and b > y) or …`.
 */
export function keysetAfter<Cursor>(columns: readonly KeysetColumn<Cursor>[], cursor: Cursor): SQL {
  const [first] = columns;

  if (!first) {
    throw new Error("A keyset order needs at least one column");
  }

  if (columns.every((column) => column.direction === first.direction)) {
    const expressions = sql.join(
      columns.map((column) => column.expression),
      sql`, `,
    );

    const values = sql.join(
      columns.map((column) => sql.param(column.cursorValue(cursor))),
      sql`, `,
    );

    return first.direction === "asc"
      ? sql`(${expressions}) > (${values})`
      : sql`(${expressions}) < (${values})`;
  }

  const after = or(
    ...columns.map((column, index) =>
      and(
        ...columns.slice(0, index).map((tied) => eq(tied.expression, tied.cursorValue(cursor))),
        column.direction === "asc"
          ? gt(column.expression, column.cursorValue(cursor))
          : lt(column.expression, column.cursorValue(cursor)),
      ),
    ),
  );

  if (!after) {
    throw new Error("A keyset order needs at least one column");
  }

  return after;
}
