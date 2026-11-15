import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Per-worktree dynamic ports (#746)
// ---------------------------------------------------------------------------
// This repo routinely runs many concurrent git worktrees under .claude/worktrees/, which
// historically all shared the fixed ports :3004 (mock API) and :3000 (next dev). With
// `reuseExistingServer` true locally, two overlapping `npm run test:e2e` runs from different
// worktrees would silently attach to whichever mock/next server was already listening — so a
// run could pass or fail against another worktree's build. Allocating a free port per run and
// threading it through the webServers, `use.baseURL`, and the specs' MOCK_API base makes
// overlapping local runs independent. #741/#744 pinned the loopback HOST to 127.0.0.1 (the
// Windows IPv4/IPv6 fix) — that is preserved below; only the PORT is dynamic, never the host.
//
// `reuseExistingServer` is off everywhere (was `!process.env.CI` = false in CI, true locally):
// with a fresh port per run there is never a matching pre-existing server to reuse, and forcing
// the rare free-port race to fail as a loud EADDRINUSE — rather than silently attach to another
// worktree's server — is exactly the guarantee #746 wants. CI stays false, so CI is unchanged.

// Grab `count` free 127.0.0.1 ports for this run. Runs in a short-lived child `node` process
// because Playwright loads this config as CommonJS — the top-level `await` a JS free-port probe
// needs is a SyntaxError here — and holds every listener open simultaneously so the OS returns
// distinct ports before releasing them for the real servers to claim. The usual free-port TOCTOU
// window applies; a lost race surfaces as a startup EADDRINUSE (loud) rather than a silent
// wrong-server reuse.
function allocatePorts(count: number): number[] {
  const probe = `
const net = require('node:net');
const count = ${count};
const servers = [];
let bound = 0;
for (let i = 0; i < count; i++) {
  const srv = net.createServer();
  srv.on('error', (e) => { console.error(e); process.exit(1); });
  servers.push(srv);
  srv.listen(0, '127.0.0.1', () => {
    if (++bound === count) {
      const ports = servers.map((s) => s.address().port);
      let closed = 0;
      for (const s of servers) s.close(() => { if (++closed === count) { process.stdout.write(ports.join(',')); process.exit(0); } });
    }
  });
}
`;
  const out = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  return out.trim().split(',').map(Number);
}

// Allocate exactly once, in the Playwright main process. The config module is re-evaluated in
// each worker and webServer child process; those inherit MOCK_API_PORT / E2E_WEB_PORT through
// the environment, so the guard below prevents a second, mismatched allocation there.
let mockPort = Number(process.env.MOCK_API_PORT);
let webPort = Number(process.env.E2E_WEB_PORT);
if (!mockPort || !webPort) {
  const [allocatedMock, allocatedWeb] = allocatePorts(2);
  mockPort ||= allocatedMock;
  webPort ||= allocatedWeb;
  process.env.MOCK_API_PORT = String(mockPort);
  process.env.E2E_WEB_PORT = String(webPort);
}

const mockApiUrl = `http://127.0.0.1:${mockPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
// Spec files (smoke/scheduling/settings/import) read their MOCK_API base from this env var
// instead of a hardcoded :3004 literal, so they hit this run's mock, not another worktree's.
process.env.PLAYWRIGHT_MOCK_API_URL = mockApiUrl;

export default defineConfig({
  testDir: './e2e',
  // staging.spec.ts is only for playwright.config.staging.ts (live Cloud Run environment).
  // Excluding it here prevents accidental runs against the local dev server, which lacks a
  // real Clerk session (window.Clerk.session is null) and would produce false failures.
  // Playwright's default testMatch also grabs `*.test.ts`; those are Jest unit tests
  // (e.g. e2e/mock-api.test.ts, which uses `describe`) and must not run under Playwright.
  testIgnore: ['**/staging.spec.ts', '**/*.test.ts'],
  // Local runs compile every page before the first test, so a cold Next dev compile on
  // Windows can't fail a test on timing (#1049). Skipped in CI, which is unchanged, and
  // with E2E_SKIP_WARMUP=1 for a quick local run of one spec against a warm .next.
  globalSetup: process.env.CI || process.env.E2E_SKIP_WARMUP ? undefined : './e2e/warmup.global-setup.ts',
  // Even with every page compiled, a dev-server render on Windows under the full suite's
  // load can outlast expect's 5 s default: a link click from the timer page to the
  // compiled workout detail page took more than 5 s once in a 92-test run (#1049), and
  // 1.9-5.0 s alone. A passing assertion returns as soon as it holds, so only a failing
  // one waits longer. Local Windows only, like Jest's win32 testTimeout (#567).
  expect: { timeout: process.platform === 'win32' && !process.env.CI ? 15_000 : 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    // 127.0.0.1 (not localhost): the webServers below bind IPv4-only on Windows, while
    // Node's verbatim DNS resolves localhost -> ::1 first, which those servers refuse
    // (ECONNREFUSED ::1). 127.0.0.1 is unambiguous IPv4 on every platform and matches the
    // bind; Linux CI is unaffected. The port is per-run dynamic (#746). See CLAUDE.md
    // "apps/web Playwright E2E (local)" and issue #741.
    baseURL: webUrl,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'node e2e/mock-api.mjs',
      // Wait on an explicit 127.0.0.1 URL, not a bare port: the mock binds 127.0.0.1 and the
      // readiness probe must dial the same address the tests use, so a localhost->::1 default
      // can't leave the probe hanging (or pass against a stale ::1 server). The port is
      // injected via MOCK_API_PORT (#746). See issue #741.
      url: `${mockApiUrl}/__reset`,
      env: { MOCK_API_PORT: String(mockPort) },
      reuseExistingServer: false,
    },
    {
      // Turbopack (Next.js 16) does not produce .next/standalone, and
      // next start with output:standalone breaks router.refresh(). Use
      // the dev server for E2E in all environments — it supports full
      // App Router cache invalidation and starts quickly with Turbopack.
      // --hostname 127.0.0.1 forces next dev to bind IPv4 loopback (its default host can
      // resolve to ::1-only on Windows); --port is per-run dynamic (#746). The explicit url
      // readiness probe dials the same 127.0.0.1:<port> the browser baseURL uses. See issue #741.
      command: `npm run dev -- --hostname 127.0.0.1 --port ${webPort}`,
      url: webUrl,
      env: {
        // Runtime public config (#396 / ADR-028): no NEXT_PUBLIC_ prefix — the root layout
        // reads these at request time and injects them into window.__PUBLIC_CONFIG__.
        // 127.0.0.1 (not localhost) — see the note on `use.baseURL` above (issue #741); the
        // mock's port is per-run dynamic (#746).
        API_URL: mockApiUrl,
        PUBLIC_API_URL: mockApiUrl,
        DEFAULT_PROGRAM: '5-3-1',
        DEV_AUTH_TOKEN: 'e2e-test',
        // @clerk/testing@2 upgraded @clerk/clerk-react to a version that throws
        // throwMissingSecretKeyError during startup when CLERK_SECRET_KEY is absent.
        // A non-empty placeholder suppresses the throw; the middleware bypasses Clerk
        // entirely when DEV_AUTH_TOKEN is set, so this key is never used for auth.
        // CLERK_PUBLISHABLE_KEY (no prefix) is passed to <ClerkProvider> as a runtime prop.
        CLERK_PUBLISHABLE_KEY: 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk',
        CLERK_SECRET_KEY: 'sk_test_e2e_placeholder',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
