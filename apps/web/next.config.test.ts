/**
 * @jest-environment node
 *
 * Locks down the pinned workspace root (#1024). Left unset, Next infers the
 * root from the outermost lockfile it finds, which in a worktree under
 * .claude/worktrees/ is the parent checkout's, and nothing in CI would notice:
 * CI and the main checkout infer the right root on their own.
 */
import fs from 'node:fs';
import path from 'node:path';
import nextConfig from './next.config';

test('turbopack.root is the monorepo root that declares the apps/* workspace', () => {
  const root = nextConfig.turbopack?.root;
  if (!root) throw new Error('next.config.ts does not set turbopack.root');

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  expect(pkg.workspaces).toContain('apps/*');
  expect(path.relative(root, __dirname)).toBe(path.join('apps', 'web'));
});

// A lifter signed in on www isn't signed in on the bare domain, where the
// Google Sheet OAuth callback returns, so www must redirect there (#1436).
test('www.liftinglogbook.com redirects every path permanently to the bare domain', async () => {
  const redirects = (await nextConfig.redirects?.()) ?? [];
  const www = redirects.filter((r) =>
    r.has?.some((h) => h.type === 'host' && h.value === 'www.liftinglogbook.com'),
  );

  expect(www).toEqual([
    {
      source: '/:path*',
      has: [{ type: 'host', value: 'www.liftinglogbook.com' }],
      destination: 'https://liftinglogbook.com/:path*',
      permanent: true,
    },
  ]);
});

test('no redirect applies to the bare domain or other hosts', async () => {
  const redirects = (await nextConfig.redirects?.()) ?? [];
  expect(redirects.every((r) => r.has?.some((h) => h.type === 'host'))).toBe(true);
});
