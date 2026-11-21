import fs from 'fs';
import path from 'path';
import React from 'react';

// Regression test for #1388: a request that skips clerkMiddleware() must still render the
// root layout without throwing.
//
// middleware.ts's matcher skips every static-extension path (`.ico`, `.css`, ...). When no
// file matches one, such as `/favicon.ico`, Next renders the 404 inside this root layout
// with no middleware context, and any server-side `auth()` call in that render throws
// "Clerk: auth() was called but Clerk can't detect usage of clerkMiddleware()". In
// production that turned every such 404 into a 500.

jest.mock('./globals.css', () => ({}));

const MIDDLEWARE_ERROR =
  "Clerk: auth() was called but Clerk can't detect usage of clerkMiddleware().";

// What `@clerk/nextjs` resolves to in the Server Component layer (its `react-server`
// build, dist/*/components.server.js): <SignedIn>, <SignedOut> and <Protect> await
// `auth()`, and <ClerkProvider> calls it only when given `dynamic`. Here `auth()` throws
// the same error it throws in production when middleware hasn't run.
jest.mock('@clerk/nextjs', () => {
  const auth = async () => {
    throw new Error(MIDDLEWARE_ERROR);
  };
  const authGated = (name: string) => {
    const component = async ({ children }: { children?: React.ReactNode }) => {
      await auth();
      return children;
    };
    Object.defineProperty(component, 'name', { value: name });
    return component;
  };
  return {
    ClerkProvider: async ({
      children,
      dynamic,
    }: {
      children?: React.ReactNode;
      dynamic?: boolean;
    }) => {
      if (dynamic) await auth();
      return children;
    },
    SignedIn: authGated('SignedIn'),
    SignedOut: authGated('SignedOut'),
    Protect: authGated('Protect'),
    UserButton: () => null,
  };
});

// Client Components are opaque references to the server render: their bodies run with the
// client build of `@clerk/nextjs`, never the server one above. The last test below checks
// that each of these modules really is a Client Component.
jest.mock('@/components/ClerkApiInitializer', () => ({
  ClerkApiInitializer: () => null,
}));
jest.mock('@/components/SignedInUserButton', () => ({
  SignedInUserButton: () => null,
}));
jest.mock('@/components/PublicConfigProvider', () => ({
  PublicConfigProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

import RootLayout from './layout';

/**
 * Renders a Server Component tree the way the server does: calls every function component
 * (awaiting async ones) and recurses into what it returns and into host elements'
 * children. Rejects if any component in the tree throws.
 */
async function renderServerTree(node: React.ReactNode): Promise<void> {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) await renderServerTree(child);
    return;
  }
  const element = node as React.ReactElement<{ children?: React.ReactNode }>;
  if (typeof element.type === 'function') {
    const Component = element.type as (
      props: unknown,
    ) => React.ReactNode | Promise<React.ReactNode>;
    await renderServerTree(await Component(element.props));
    return;
  }
  await renderServerTree(element.props.children);
}

describe('root layout without clerkMiddleware() (#1388)', () => {
  const originalDevToken = process.env.DEV_AUTH_TOKEN;
  const originalKey = process.env.CLERK_PUBLISHABLE_KEY;

  beforeEach(() => {
    // Real-Clerk mode, as in staging and production.
    delete process.env.DEV_AUTH_TOKEN;
    process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_real_instance';
  });

  afterAll(() => {
    if (originalDevToken === undefined) delete process.env.DEV_AUTH_TOKEN;
    else process.env.DEV_AUTH_TOKEN = originalDevToken;
    if (originalKey === undefined) delete process.env.CLERK_PUBLISHABLE_KEY;
    else process.env.CLERK_PUBLISHABLE_KEY = originalKey;
  });

  it('renders the 404 for a missing static-extension path without calling auth()', async () => {
    const notFound = React.createElement('h1', null, '404: This page could not be found.');

    await expect(
      renderServerTree(RootLayout({ children: notFound })),
    ).resolves.toBeUndefined();
  });

  it.each(['ClerkApiInitializer', 'SignedInUserButton', 'PublicConfigProvider'])(
    'components/%s.tsx is a Client Component, as the server render above assumes',
    (name) => {
      const source = fs.readFileSync(
        path.join(__dirname, '..', 'components', `${name}.tsx`),
        'utf8',
      );
      expect(source).toMatch(/^['"]use client['"];?/);
    },
  );
});
