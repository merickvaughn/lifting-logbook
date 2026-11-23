import React from 'react';

// The root layout imports global (non-module) CSS. The web jest config only maps
// `.module.css`, and ts-jest only transforms `.tsx?`, so a real `./globals.css` import
// would reach jest untransformed and throw. Stub it — this suite asserts on the returned
// element tree, not styling.
jest.mock('./globals.css', () => ({}));

// Mock the Clerk client surface and the API initializer so we can assert on stable
// component identities without importing the real (browser-oriented) Clerk SDK. The
// layout is never rendered here (we inspect the returned element tree structurally, the
// same approach as (authed)/layout.test.tsx), so the stub bodies are never invoked.
jest.mock('@clerk/nextjs', () => ({
  ClerkProvider: function ClerkProvider() {
    return null;
  },
  SignedIn: function SignedIn() {
    return null;
  },
  UserButton: function UserButton() {
    return null;
  },
}));

jest.mock('@/components/ClerkApiInitializer', () => ({
  ClerkApiInitializer: function ClerkApiInitializer() {
    return null;
  },
}));

jest.mock('@/components/SignedInUserButton', () => ({
  SignedInUserButton: function SignedInUserButton() {
    return null;
  },
}));

import RootLayout from './layout';
import { ClerkProvider, SignedIn } from '@clerk/nextjs';
import { ClerkApiInitializer } from '@/components/ClerkApiInitializer';
import { SignedInUserButton } from '@/components/SignedInUserButton';

/** Recursively true if any element in the tree has `.type === type`. */
function containsType(node: React.ReactNode, type: React.ElementType): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((child) => containsType(child, type));
  const element = node as React.ReactElement;
  if (element.type === type) return true;
  const children = (element.props as { children?: React.ReactNode }).children;
  return containsType(children, type);
}

/** Recursively true if the exact `target` node instance appears anywhere in the tree. */
function containsNode(node: React.ReactNode, target: React.ReactNode): boolean {
  if (node === target) return true;
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((child) => containsNode(child, target));
  const element = node as React.ReactElement;
  const children = (element.props as { children?: React.ReactNode }).children;
  return containsNode(children, target);
}

const CHILDREN = React.createElement('main', { 'data-testid': 'children' });

describe('root layout — Clerk client tree gated on dev-auth mode (#834)', () => {
  const originalDevToken = process.env.DEV_AUTH_TOKEN;
  const originalKey = process.env.CLERK_PUBLISHABLE_KEY;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DEV_AUTH_TOKEN;
    delete process.env.CLERK_PUBLISHABLE_KEY;
    // readServerPublicConfig / readServerClerkPublishableKey only throw in a deployed
    // runtime (NODE_ENV === 'production'); keep each test on the non-deployed path.
    (process.env as Record<string, string>).NODE_ENV = 'test';
  });

  afterAll(() => {
    if (originalDevToken === undefined) delete process.env.DEV_AUTH_TOKEN;
    else process.env.DEV_AUTH_TOKEN = originalDevToken;
    if (originalKey === undefined) delete process.env.CLERK_PUBLISHABLE_KEY;
    else process.env.CLERK_PUBLISHABLE_KEY = originalKey;
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
  });

  it('dev-auth mode: returns the <html> shell with no Clerk client tree, children preserved', () => {
    process.env.DEV_AUTH_TOKEN = 'dev-user';
    // Even with a publishable key present, dev-auth mode must skip the Clerk client tree
    // (this is what silences the #834 console error — ClerkJS never initializes).
    process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_ZXhhbXBsZQ';

    const element = RootLayout({ children: CHILDREN }) as React.ReactElement;

    // Top-level element is the raw <html>, not a <ClerkProvider> wrapper.
    expect(element.type).toBe('html');
    expect(containsType(element, ClerkProvider)).toBe(false);
    expect(containsType(element, ClerkApiInitializer)).toBe(false);
    expect(containsType(element, SignedInUserButton)).toBe(false);
    // Page content still passes through verbatim.
    expect(containsNode(element, CHILDREN)).toBe(true);
  });

  it('real-Clerk mode: wraps in <ClerkProvider> with the publishable key and mounts the Clerk client tree', () => {
    // DEV_AUTH_TOKEN stays unset (cleared in beforeEach).
    process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_real_instance';

    const element = RootLayout({ children: CHILDREN }) as React.ReactElement;

    expect(element.type).toBe(ClerkProvider);
    expect((element.props as { publishableKey?: string }).publishableKey).toBe(
      'pk_test_real_instance',
    );
    // The single child of <ClerkProvider> is the shared <html> shell.
    const shell = (element.props as { children: React.ReactElement }).children;
    expect(shell.type).toBe('html');
    // The Clerk client tree is mounted in this mode.
    expect(containsType(element, ClerkApiInitializer)).toBe(true);
    expect(containsType(element, SignedInUserButton)).toBe(true);
    // The server-side <SignedIn> is never rendered here: it calls auth(), which throws
    // when middleware hasn't run (#1388).
    expect(containsType(element, SignedIn)).toBe(false);
    expect(containsNode(element, CHILDREN)).toBe(true);
  });
});
