import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import styles from "./home.module.css";

// `DEV_AUTH_TOKEN` mirrors the middleware/layout escape hatch for mock-API
// dev mode, hard-gated to non-production so it cannot bypass auth in deployed
// environments. See `app/(authed)/layout.tsx` for the rationale.
export default async function Home() {
  // Bracket access on NODE_ENV defeats Next.js's SWC transform that would
  // otherwise inline the build-time value and make the runtime check unreachable.
  const devBypass =
    process.env["NODE_ENV"] !== "production" && process.env.DEV_AUTH_TOKEN;
  if (!devBypass) {
    const { userId } = await auth();
    if (userId) redirect("/macrocycle");
  }
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <h1 className={styles.wordmark}>Lifting Logbook</h1>
          <p className={styles.tagline}>Track your lifts. Run the program.</p>
        </div>
        <nav className={styles.ctaList} aria-label="Primary navigation">
          <Link href="/macrocycle" className={styles.cta}>
            <span>Current Macrocycle</span>
            <span className={styles.ctaArrow} aria-hidden="true">
              →
            </span>
          </Link>
          <Link href="/settings/training-maxes" className={styles.cta}>
            <span>Training Maxes</span>
            <span className={styles.ctaArrow} aria-hidden="true">
              →
            </span>
          </Link>
          <Link
            href="/onboarding"
            className={`${styles.cta} ${styles.ctaSecondary}`}
          >
            <span>Get Started</span>
            <span className={styles.ctaArrow} aria-hidden="true">
              →
            </span>
          </Link>
        </nav>
      </div>
    </main>
  );
}
