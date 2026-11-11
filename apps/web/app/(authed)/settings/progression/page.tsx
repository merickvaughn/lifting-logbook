import { fetchUserSettings } from '@/lib/api';
import DefaultProgressionForm from './DefaultProgressionForm';

export default async function ProgressionPage() {
  // Fall back to no default when the API is unreachable — matches
  // settings/weight-rounding/page.tsx, and keeps the build-time prerender from crashing
  // when no API is running.
  // fallback-covered-by: apps/web/app/(authed)/settings/progression/page.test.tsx
  const initial = await fetchUserSettings()
    .then((settings) => settings.defaultProgression ?? null)
    .catch(() => null);
  return <DefaultProgressionForm initialDefault={initial} />;
}
