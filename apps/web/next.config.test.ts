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
