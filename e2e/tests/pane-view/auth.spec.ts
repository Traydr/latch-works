import { expect, test } from "@playwright/test";
import { PANE_VIEW_CREDENTIALS } from "../../src/env.ts";

test.describe("auth", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the gallery redirects to the login page when signed out", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("wrong credentials are rejected and repeated failures are throttled", async ({
    page,
    request,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Username").fill(PANE_VIEW_CREDENTIALS.username);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/error=invalid/);
    await expect(page.getByText("Those credentials did not match Pane View.")).toBeVisible();

    // Five failures within the window lock the account+ip bucket: even the right
    // password is refused afterwards. Use a throwaway username so the stored session
    // and the other specs are unaffected.
    const username = `throttled-${Date.now()}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request.post("/api/auth/login", {
        form: { password: "wrong", username },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(303);
      expect(response.headers().location).toBe("/login?error=invalid");
    }
    const locked = await request.post("/api/auth/login", {
      form: { password: PANE_VIEW_CREDENTIALS.password, username },
      maxRedirects: 0,
    });
    expect(locked.headers().location).toBe("/login?error=invalid");
  });

  test("signing out returns to the login page", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username").fill(PANE_VIEW_CREDENTIALS.username);
    await page.getByLabel("Password").fill(PANE_VIEW_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("region", { name: "Archive browser" })).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});
