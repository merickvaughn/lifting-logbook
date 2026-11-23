import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained build under .next/standalone for the Docker
  // runner stage to copy. Without this, .next/standalone is never created
  // and the runner-stage COPY fails.
  // https://nextjs.org/docs/app/api-reference/next-config-js/output
  output: "standalone",
  // Pin the workspace root to this repo's root (two levels up from apps/web).
  // Left unset, Next infers it from the outermost lockfile it can find, which
  // in a worktree under .claude/worktrees/ is the parent checkout's. Next also
  // copies this value into outputFileTracingRoot, so the standalone output
  // keeps its apps/web/ layout. See #1024.
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
  // Send www to the bare domain, keeping the path and query. Clerk's session
  // cookie is host-only, so a lifter signed in on www isn't signed in on the
  // bare domain, where the Google Sheet OAuth callback returns (ADR-047). It
  // also gives every page one address. Only production has this host. See #1436.
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/redirects#header-cookie-and-query-matching
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.liftinglogbook.com" }],
        destination: "https://liftinglogbook.com/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
