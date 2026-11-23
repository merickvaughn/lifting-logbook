import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from "next";
import { ClerkApiInitializer } from '@/components/ClerkApiInitializer';
import { PublicConfigProvider } from '@/components/PublicConfigProvider';
import { SignedInUserButton } from '@/components/SignedInUserButton';
import {
  publicConfigScript,
  readServerClerkPublishableKey,
  readServerPublicConfig,
} from '@/lib/public-config';
import "./globals.css";

export const metadata: Metadata = {
  title: "Lifting Logbook",
  description: "Track your lifts.",
};

// The root layout reads public config from process.env at request time and injects it
// into window.__PUBLIC_CONFIG__ / <ClerkProvider> (see below). Force dynamic rendering so
// those reads happen per request rather than being evaluated once during build-time
// static prerendering — static prerender would bake build-time env values into the
// shipped HTML and defeat the runtime-injection contract this refactor exists to restore
// (#396 / ADR-028). The app is auth-gated and already renders dynamically in practice;
// this makes the requirement explicit and also removes the build-time Clerk publishable
// key that /_not-found prerendering previously required.
export const dynamic = 'force-dynamic';

const themeInitScript =
  "(function(){try{var t=localStorage.getItem('theme');" +
  "if(t!=='navy'&&t!=='iron')t='navy';" +
  "document.documentElement.setAttribute('data-theme',t);}catch(e){" +
  "document.documentElement.setAttribute('data-theme','navy');}})();";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // When DEV_AUTH_TOKEN is set (Playwright CI, local dev-auth mode), the
  // middleware bypasses clerkMiddleware() entirely and the browser authenticates
  // with the dev bearer token (window.__PUBLIC_CONFIG__.devAuthToken) rather than a
  // Clerk session — so Clerk is inert for auth. The whole Clerk *client* tree is
  // therefore skipped in this mode:
  //   • <ClerkProvider> — mounting it would still initialize ClerkJS in the browser
  //     against the non-real example publishable key and log a benign but noisy
  //     "unable to attribute this request to an instance" console error (#834).
  //   • <ClerkApiInitializer> — calls useAuth(), which requires a <ClerkProvider>
  //     ancestor; it is unused here anyway (getClientAuthHeaders in lib/client-api.ts
  //     uses the dev token first and never calls Clerk's getToken).
  //   • <SignedInUserButton> — its <SignedIn>/<UserButton> need a <ClerkProvider>.
  //     It is a Client Component so that <SignedIn> never calls auth() server-side:
  //     a 404 for a static-extension path renders this layout without middleware,
  //     where auth() throws (#1388).
  // The sign-in page carries the same DEV_AUTH_TOKEN guard so /sign-in does not render
  // a <ClerkProvider>-less <SignIn/> in this mode (#834). Real-Clerk mode is unchanged.
  const devAuthMode = Boolean(process.env.DEV_AUTH_TOKEN);

  // Public config is read here at request time (this is a Server Component) and
  // injected at runtime — NOT baked into the bundle at build time. The inline
  // <head> script populates window.__PUBLIC_CONFIG__ before hydration (consumed by
  // lib/client-api.ts); the same object is passed to <PublicConfigProvider> for
  // React components, and the Clerk publishable key is passed to <ClerkProvider> as
  // a prop (Clerk's runtime-key pattern). See ADR-028 / issue #396.
  const publicConfig = readServerPublicConfig();
  // Fail loud in a deployed runtime if the Clerk publishable key is missing, rather than
  // rendering <ClerkProvider> with an undefined key (auth would break silently in the
  // browser). Matches the API-side guard in apps/api/src/auth/auth.module.ts. See #687.
  // Consumed only in the real-Clerk branch below; in dev-auth mode <ClerkProvider> is
  // not rendered, so the key is legitimately absent and unused.
  const clerkPublishableKey = readServerClerkPublishableKey();

  // The HTML shell is identical in both modes; only the <ClerkProvider> wrapper and the
  // Clerk client children differ (both gated on devAuthMode).
  const shell = (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: publicConfigScript(publicConfig) }}
        />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <PublicConfigProvider config={publicConfig}>
          {!devAuthMode && <ClerkApiInitializer />}
          {!devAuthMode && <SignedInUserButton />}
          {children}
        </PublicConfigProvider>
      </body>
    </html>
  );

  // Dev-auth mode: return the shell WITHOUT <ClerkProvider> so ClerkJS never initializes
  // in the browser (silences the #834 console error). Real-Clerk mode (staging/production
  // or a real local pk_ key): wrap in <ClerkProvider> exactly as before.
  if (devAuthMode) {
    return shell;
  }

  return (
    <ClerkProvider publishableKey={clerkPublishableKey}>{shell}</ClerkProvider>
  );
}
