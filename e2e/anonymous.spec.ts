import { expect, test } from "@playwright/test";

/**
 * What an anonymous visitor and an unauthenticated machine caller get from
 * the real production build. Every one of these is a boundary: a regression
 * here is a page leaking to the public or an endpoint answering without its
 * secret.
 */

test("the login page renders a usable, labelled form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByLabel(/email/i)).toBeVisible();
  await expect(page.getByLabel(/password/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in|log in|continue/i })).toBeEnabled();
});

test("the login page fits a phone without horizontal scrolling", async ({ page }) => {
  await page.goto("/login");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

for (const path of ["/dashboard", "/sites/00000000-0000-0000-0000-000000000000", "/users", "/marketplace", "/account"]) {
  test(`${path} sends an anonymous visitor to /login`, async ({ page }) => {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  });
}

test("a malformed report share link is a plain 404", async ({ request }) => {
  const res = await request.get("/r/not-a-token", { maxRedirects: 0 });
  expect(res.status()).toBe(404);
});

test("the MCP endpoint refuses a request without a token, instead of redirecting to /login", async ({ request }) => {
  const res = await request.post("/api/mcp", {
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    headers: { accept: "application/json, text/event-stream" },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(401);
});

for (const path of ["/api/cron/process", "/api/cron/enqueue", "/api/cron/uptime"]) {
  test(`${path} refuses a call without the cron secret`, async ({ request }) => {
    const res = await request.post(path, { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false });
  });
}

test("the n8n webhook refuses an unsigned callback", async ({ request }) => {
  const res = await request.post("/api/webhooks/n8n/geogrid", { data: {}, maxRedirects: 0 });
  expect(res.status()).toBeGreaterThanOrEqual(400);
  expect(res.status()).toBeLessThan(500);
});
