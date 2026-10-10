'use strict';

const { RuleTester } = require('eslint');
const test = require('node:test');

const rule = require('./no-raw-fetch-outside-api-client');

// RuleTester needs a TS-aware parser; resolved from the monorepo root devDependency, matching
// require-fetch-cache.test.js. Filenames are virtual (no type-aware `project`), so the rule's
// filename-allowlist check is exercised purely on the passed `filename`.
const tsParser = require('@typescript-eslint/parser');

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

test('no-raw-fetch-outside-api-client', () => {
  tester.run('no-raw-fetch-outside-api-client', rule, {
    valid: [
      // Calls through the typed client are the sanctioned path.
      { code: 'apiClient.fetchMacrocycleDashboard(id);', filename: 'apps/web/app/page.ts' },
      // Member `.fetch` is not a bare fetch() call.
      { code: 'client.fetch(url);', filename: 'apps/web/app/page.ts' },
      // A non-auth header object outside the wrappers is fine.
      { code: "const h = { 'Content-Type': 'application/json' };", filename: 'apps/web/app/page.ts' },
      // Allowlisted wrapper modules legitimately call fetch() and set auth headers.
      { code: "fetch(url, { cache: 'no-store' });", filename: 'apps/web/lib/api.ts' },
      { code: 'const h = { Authorization: `Bearer ${t}` };', filename: 'apps/web/lib/client-api.ts' },
      // gcp-identity-token.ts is allowlisted: metadata-server fetch + Metadata-Flavor header.
      {
        code: "fetch(metadataUrl, { headers: { 'Metadata-Flavor': 'Google' }, cache: 'no-store' });",
        filename: 'apps/web/lib/gcp-identity-token.ts',
      },
    ],
    invalid: [
      // Bare fetch() in a non-wrapper file.
      {
        code: "fetch('https://api.example.com/x', { cache: 'no-store' });",
        filename: 'apps/web/app/page.ts',
        errors: [{ messageId: 'rawFetch' }],
      },
      {
        code: 'fetch(url);',
        filename: 'apps/web/app/history/page.ts',
        errors: [{ messageId: 'rawFetch' }],
      },
      // Hand-built auth headers outside the wrappers.
      {
        code: 'const h = { Authorization: `Bearer ${t}` };',
        filename: 'apps/web/app/page.ts',
        errors: [{ messageId: 'authHeader' }],
      },
      {
        code: "const h = { 'X-Clerk-Authorization': v };",
        filename: 'apps/web/app/page.ts',
        errors: [{ messageId: 'authHeader' }],
      },
    ],
  });
});
