import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LIFT_NAMES } from "@lifting-logbook/types";
import { fetchMacrocycleDashboard, fetchLiftCatalog } from "@/lib/api";
import { getActiveProgram } from "@/lib/active-program";
import { OnboardingFlow } from "./OnboardingFlow";

export const metadata: Metadata = {
  title: "Get Started — Lifting Logbook",
  description: "Discover your training maxes and choose a program.",
};

export default async function OnboardingPage() {
  const program = await getActiveProgram();

  // Skip onboarding if a macrocycle already exists — send the user directly to their
  // current macrocycle view. This handles users who land on /onboarding with an existing
  // macrocycle (e.g. via the "Get Started" link, a browser back, or after the pre-#594
  // redirect-swallow bug left them stuck here).
  // fallback-covered-by: apps/web/app/(authed)/onboarding/page.test.tsx
  const existingDashboard = await fetchMacrocycleDashboard(program).catch(() => null);
  if (existingDashboard) redirect(`/macrocycle/${existingDashboard.macrocycleNum}`);

  // The catalog (built-in + the user's custom lifts) powers the add-a-lift
  // picker on the "Enter Lifts" step. getLifts keys off the authenticated user
  // and ignores the :program param, so the active-program default is safe even
  // before a macrocycle exists.
  //
  // On fetch failure we fall back to the full built-in LIFT_NAMES rather than
  // a short default list: LIFT_NAMES keeps the add-a-lift picker fully searchable
  // even when the API is down, so users can add any catalog lift while entering
  // their training maxes. The failure is logged rather than swallowed so the
  // upstream catalog-fetch failure is observable (#458).
  // Fallback coverage (docs/standards/error-fallback-test-coverage.md, option b):
  // page.test.tsx asserts the fallback catalog is the full built-in list.
  let catalog: string[];
  try {
    catalog = await fetchLiftCatalog(program);
  } catch (e) {
    console.error(
      "OnboardingPage: lift catalog fetch failed, falling back to built-in LIFT_NAMES",
      e,
    );
    catalog = [...LIFT_NAMES];
  }

  return <OnboardingFlow catalog={catalog} />;
}
