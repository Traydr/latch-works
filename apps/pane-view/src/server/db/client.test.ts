import { describe, expect, it } from "vitest";
import { createPaneViewDb } from "./client";

describe("pane view database client", () => {
  it("reuses the process-level client for the same database URL", () => {
    const databaseUrl = "postgres://pane-view.invalid/pane_view";

    expect(createPaneViewDb(databaseUrl)).toBe(createPaneViewDb(databaseUrl));
  });
});
