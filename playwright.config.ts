import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke tests against the production build (`next start`).
 *
 * They need no Supabase project: the placeholder URL is unreachable, so every
 * session is anonymous, and the suite pins what an anonymous visitor and an
 * unauthenticated machine caller get — the login page, redirects, and the
 * self-authenticating routes' refusals. Flows that need a signed-in user or a
 * live WordPress site stay in the Vitest suite, which mocks those edges.
 *
 * Run: `npm run build && npm run test:e2e`. Set PW_CHROMIUM_PATH to use a
 * preinstalled Chromium instead of `npx playwright install chromium`.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Desktop Chrome"],
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "phone", use: { ...devices["Pixel 7"], launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {} } },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
