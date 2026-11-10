import { test, expect } from '@playwright/test';

// #1198: a macrocycle's number can change, so a workout URL can name an old one. Each
// workout page redirects to the number the workout was read from. The mock API serves every
// workout as macrocycle 1, so macrocycle 7 stands for a number that has since moved.
const OLD = '/macrocycle/7/workout/1';
const CURRENT = '/macrocycle/1/workout/1';

// Next dev compiles a route on its first visit, which on Windows can exceed the default
// timeouts (#698). Warm the routes once so each test runs against compiled ones.
test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  await page.goto(CURRENT, { timeout: 90_000 });
  await page.goto(`${CURRENT}/detail`, { timeout: 90_000 });
  await page.close();
});

for (const suffix of ['', '/detail']) {
  test(`an old URL${suffix ? ` for ${suffix}` : ''} redirects once to the current number`, async ({ page }) => {
    const visited: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
    });

    const response = await page.goto(`${OLD}${suffix}`);

    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`${CURRENT}${suffix}$`));
    // No loop: after settling, the page has stayed put on the current number.
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).pathname).toBe(`${CURRENT}${suffix}`);
    expect(visited.filter((path) => path === `${CURRENT}${suffix}`).length).toBeLessThanOrEqual(1);
  });
}
