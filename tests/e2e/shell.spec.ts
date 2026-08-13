import { test, expect } from "@playwright/test";

test("home shell renders the tokened layout", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "zedHR" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clock In" })).toBeVisible();
});
