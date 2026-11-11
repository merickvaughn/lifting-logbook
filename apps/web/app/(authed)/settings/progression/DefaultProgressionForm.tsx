'use client';

import { useState } from 'react';
import type { DefaultProgressionSetting } from '@lifting-logbook/types';
import ProgressionFields from '@/components/ProgressionFields';
import { logClientError } from '@/lib/log-client-error';
import { parseProgressionDraft, progressionDraft } from '@/lib/progression';
import { saveDefaultProgression } from './actions';

const toDraft = (setting: DefaultProgressionSetting | null) =>
  progressionDraft({
    type: setting?.type ?? null,
    increment: setting?.increment ?? null,
    repsLow: setting?.repsLow ?? null,
    repsHigh: setting?.repsHigh ?? null,
  });

export default function DefaultProgressionForm({
  initialDefault,
}: {
  initialDefault: DefaultProgressionSetting | null;
}) {
  const [draft, setDraft] = useState(() => toDraft(initialDefault));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    setSavedAt(null);
    const parsed = parseProgressionDraft(draft);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    const { type, increment, repsLow, repsHigh } = parsed.values;
    setSaving(true);
    try {
      const result = await saveDefaultProgression(type === null ? null : { type, increment, repsLow, repsHigh });
      setDraft(toDraft(result.defaultProgression));
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      logClientError('saveDefaultProgression', err);
      setError('Failed to save your default progression. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2>Progression</h2>
      <p>
        Sets how a lift&apos;s training max moves when the lift has no progression of its own,
        built-in lifts included. Leave it on the catalog default to let each lift use the type
        the app gives it. A lift&apos;s own setting in Manage Lifts wins over this, and a program
        row that sets its own progression wins inside that program; every built-in program
        keeps today&apos;s rule.
      </p>

      <ProgressionFields
        idPrefix="default-progression"
        label="Default progression"
        unsetLabel="Each lift's catalog default"
        value={draft}
        onChange={(next) => {
          setDraft(next);
          setSavedAt(null);
        }}
        disabled={saving}
      />

      <div>
        <button type="button" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {error && <p role="alert">{error}</p>}
        {savedAt && <p>Saved at {savedAt}.</p>}
      </div>
    </section>
  );
}
