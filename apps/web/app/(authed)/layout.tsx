import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import TimeZoneCookie from '@/components/TimeZoneCookie';
import AppNav from './AppNav';

/**
 * Defense-in-depth auth guard for all protected routes.
 *
 * Adds a server-side `auth()` check at the layout level so a middleware
 * misconfiguration (see #382/#383) no longer opens protected pages.
 * The middleware (`apps/web/middleware.ts`) is the first line of defense;
 * this is the second. Do not remove without a replacement layer — see #384.
 *
 * `DEV_AUTH_TOKEN` mirrors the middleware's escape hatch so mock-API dev
 * mode still works, but is hard-gated to non-production environments here
 * so a misconfigured production env var cannot bypass auth.
 */
export default async function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Bracket access on NODE_ENV defeats Next.js's SWC transform that would
  // otherwise inline the build-time value and make the runtime check unreachable.
  if (
    process.env['NODE_ENV'] !== 'production' &&
    process.env.DEV_AUTH_TOKEN
  ) {
    return (
      <>
        <AppNav />
        <TimeZoneCookie />
        {children}
      </>
    );
  }
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  return (
    <>
      <AppNav />
      <TimeZoneCookie />
      {children}
    </>
  );
}
