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
    // A reload loop shows up as repeated page loads, so the test records every document
    // request: the old URL, then the current one its redirect points at, and nothing after.
    const documentLoads: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documentLoads.push(new URL(request.url()).pathname);
    });

    await page.goto(`${OLD}${suffix}`);

    await expect(page).toHaveURL(new RegExp(`${CURRENT}${suffix}$`));
    const expected = [`${OLD}${suffix}`, `${CURRENT}${suffix}`];
    await expect.poll(() => documentLoads).toEqual(expected);
    // A loop would load another document soon after; none arrives within a second.
    await expect(
      page.waitForRequest((request) => request.resourceType() === 'document', { timeout: 1_000 }),
    ).rejects.toThrow();
    expect(documentLoads).toEqual(expected);
  });
}
