'use client';

import { SignedIn, UserButton } from '@clerk/nextjs';

/**
 * The signed-in user's avatar menu, pinned to the top-right of every page.
 *
 * This is a Client Component on purpose (#1388). In a Server Component, `@clerk/nextjs`
 * resolves `<SignedIn>` to its server build, which calls `auth()`. `auth()` throws when
 * `clerkMiddleware()` hasn't run for the request, and `middleware.ts`'s matcher skips
 * every static-extension path (`.ico`, `.css`, ...). A request for a missing one, such as
 * `/favicon.ico`, renders the 404 inside the root layout without middleware, so a
 * server-side `<SignedIn>` there turned every such 404 into a 500. Imported from a
 * `'use client'` module, `<SignedIn>` resolves to the client build, which reads the
 * session from `<ClerkProvider>` in the browser and never calls `auth()`.
 */
export function SignedInUserButton() {
  return (
    <SignedIn>
      <div
        style={{
          position: 'fixed',
          top: '1rem',
          right: '1rem',
          zIndex: 50,
        }}
      >
        <UserButton afterSignOutUrl="/sign-in" />
      </div>
    </SignedIn>
  );
}
