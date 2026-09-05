// @ts-check

/** @type {import('eslint').Linter.FlatConfig[]} */
module.exports = [
  // Inherit root TypeScript rules
  ...require('../../eslint.config.js'),
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // packages/core is a pure domain library with no logger port; a console call
      // here is stray debug output (the GAS-era residue #983 removed), never
      // observability — apps/api logs under pino at the call site instead.
      'no-console': 'error',
      // Enforce the hexagonal architecture boundary defined in ADR-002.
      // packages/core is pure domain logic — it must never import from app
      // workspaces or infrastructure packages. Violations mean the dependency
      // rule is inverted; use a port interface instead.
      'no-restricted-imports': ['error', {
        // Exact-match ban: prevents regression of the circular barrel import
        // that caused Jest worker OOM (issue #89, fixed in PR #91).
        // `paths` matches the literal specifier only — sub-paths like
        // @src/core/models are unaffected.
        paths: [
          {
            name: '@src/core',
            message:
              "Import from the root barrel '@src/core' is not allowed inside " +
              "packages/core/src — use a direct sub-path such as '@src/core/models', " +
              "'@src/core/constants', or '@src/core/utils/jsUtil' instead.",
          },
          // '@src/core/*' in tsconfig maps @src/core/index → src/index.ts, so
          // the explicit-index form resolves to the same barrel and must also be banned.
          {
            name: '@src/core/index',
            message:
              "Import from the root barrel '@src/core/index' is not allowed inside " +
              "packages/core/src — use a direct sub-path such as '@src/core/models', " +
              "'@src/core/constants', or '@src/core/utils/jsUtil' instead.",
          },
        ],
        patterns: [
          {
            group: [
              '@lifting-logbook/api',
              '@lifting-logbook/api-legacy',
              '@lifting-logbook/web',
              '@lifting-logbook/mobile',
            ],
            message:
              'packages/core must not import from app workspaces. ' +
              'Dependency must flow inward (ADR-002).',
          },
          {
            group: [
              '@prisma/client',
              'prisma',
              'typeorm',
              'sequelize',
              'knex',
              'drizzle-orm',
              'mongoose',
              'pg',
              'postgres',
              'mysql2',
              'mysql',
              'sqlite3',
              'better-sqlite3',
              'redis',
              'ioredis',
            ],
            message:
              'packages/core must not import database or ORM packages. ' +
              'Use a port interface instead (ADR-002).',
          },
          {
            group: [
              'express',
              'fastify',
              '@nestjs/*',
              'koa',
              '@hapi/hapi',
            ],
            message:
              'packages/core must not import HTTP server frameworks. ' +
              'These belong in the adapter layer (ADR-002).',
          },
          {
            group: [
              'axios',
              'node-fetch',
              'got',
              'cross-fetch',
              'undici',
              'superagent',
            ],
            message:
              'packages/core must not import HTTP client libraries. ' +
              'Use a port interface instead (ADR-002).',
          },
          {
            group: [
              'passport',
              'passport-*',
              'jsonwebtoken',
              'bcrypt',
              'bcryptjs',
              'argon2',
            ],
            message:
              'packages/core must not import auth libraries. ' +
              'Use a port interface instead (ADR-002).',
          },
          {
            group: [
              '@google-cloud/*',
              '@aws-sdk/*',
              'aws-sdk',
              '@azure/*',
            ],
            message:
              'packages/core must not import cloud SDK packages. ' +
              'These belong in the adapter layer (ADR-002).',
          },
        ],
      }],
    },
  },
];
