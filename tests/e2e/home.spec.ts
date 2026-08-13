import { test, expect } from "@playwright/test";

test("home renders the tokened shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "zedHR" })).toBeVisible();
});
