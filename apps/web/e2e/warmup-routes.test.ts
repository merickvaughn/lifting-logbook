/** @jest-environment node */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWarmupRoutes } from './warmup-routes';

// The e2e global setup (#1049) warms the routes this returns, so a page it misses is a
// page whose first compile can still fail a test on timing.

let appDir: string;

function page(...dirs: string[]) {
  const dir = join(appDir, ...dirs);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'page.tsx'), '');
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), 'warmup-routes-'));
});

afterEach(() => {
  rmSync(appDir, { recursive: true, force: true });
});

test('maps route groups, dynamic segments and optional catch-alls to URLs', () => {
  page();
  page('(authed)', 'glossary');
  page('(authed)', 'macrocycle', '[macrocycleNum]', 'workout', '[workoutNum]', 'detail', '[lift]');
  page('docs', '[[...slug]]');
  writeFileSync(join(appDir, '(authed)', 'layout.tsx'), '');
  mkdirSync(join(appDir, 'api', 'health'), { recursive: true });
  writeFileSync(join(appDir, 'api', 'health', 'route.ts'), '');

  expect(listWarmupRoutes(appDir)).toEqual([
    '/',
    '/docs',
    '/glossary',
    '/macrocycle/1/workout/1/detail/squat',
  ]);
});

test('skips the Clerk sign-in page', () => {
  page('sign-in', '[[...sign-in]]');
  page('history');

  expect(listWarmupRoutes(appDir)).toEqual(['/history']);
});

test('throws on a dynamic segment it has no value for', () => {
  page('programs', '[programId]');

  expect(() => listWarmupRoutes(appDir)).toThrow(/no value for dynamic segment \[programId\]/);
});

test("covers the app's pages, including the soft-navigation targets that failed cold", () => {
  const routes = listWarmupRoutes(join(__dirname, '..', 'app'));

  expect(routes).toEqual(
    expect.arrayContaining([
      '/glossary',
      '/macrocycle/1',
      '/macrocycle/1/program',
      '/macrocycle/1/workout/1',
      '/macrocycle/1/workout/1/detail',
      '/programs/focus',
    ]),
  );
  expect(routes).not.toContain('/sign-in');
});
