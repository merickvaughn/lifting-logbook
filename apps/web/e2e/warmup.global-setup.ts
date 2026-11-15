import { chromium, type FullConfig } from '@playwright/test';
import { join } from 'node:path';
import { listWarmupRoutes } from './warmup-routes';

// Next dev compiles each route the first time it is requested. On Windows a cold compile
// can take longer than the waits in the specs, so a test that is the first to reach a
// route fails on compile time rather than on the code: a link click whose soft navigation
// doesn't land within toHaveURL's 5 s, or a click that a still-hydrating page drops
// (#1049, and the per-spec beforeAll warmups since #698). Playwright starts the webServers
// before global setup, so this loads every page once, sequentially, before any test runs.
// playwright.config.ts registers it for local runs only; CI on Linux compiles fast enough.
const ROUTE_TIMEOUT_MS = 180_000;

export default async function warmup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL;
  if (!baseURL) throw new Error('e2e warmup: the chromium project has no baseURL');
  const routes = listWarmupRoutes(join(__dirname, '..', 'app'));

  const started = Date.now();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL });
    for (const route of routes) {
      const t0 = Date.now();
      const response = await page.goto(route, { waitUntil: 'load', timeout: ROUTE_TIMEOUT_MS });
      const seconds = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[e2e warmup] ${route} -> ${response?.status() ?? 'no response'} (${seconds}s)`);
    }
  } finally {
    await browser.close();
  }
  // Leave the mock as a fresh run finds it, for specs that don't reset it themselves.
  await fetch(`${process.env.PLAYWRIGHT_MOCK_API_URL}/__reset`);
  console.log(`[e2e warmup] ${routes.length} routes in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
