'use client';

import { useState } from 'react';
import SetVolumeTable, { type VolumeTableColumn } from './SetVolumeTable';
import styles from './VolumeSummary.module.css';

type View = 'muscle' | 'pattern';

interface Props {
  /** What the sets are, such as "Weekly working sets"; each table's caption adds its view. */
  caption: string;
  /** The same sets counted per muscle group, and per movement pattern. */
  muscles: readonly VolumeTableColumn[];
  patterns: readonly VolumeTableColumn[];
}

/**
 * Weekly working sets with a Muscles / Patterns toggle (#1013). The caller counts both views,
 * since only it knows where the sets come from; this only switches between the tables.
 */
export default function VolumeSummary({ caption, muscles, patterns }: Props) {
  const [view, setView] = useState<View>('muscle');

  const option = (value: View, label: string) => (
    <button
      type="button"
      className={styles.option}
      aria-pressed={view === value}
      onClick={() => setView(value)}
    >
      {label}
    </button>
  );

  return (
    <div className={styles.summary}>
      <div role="group" aria-label="Count sets by" className={styles.toggle}>
        {option('muscle', 'Muscles')}
        {option('pattern', 'Patterns')}
      </div>
      {view === 'muscle' ? (
        <SetVolumeTable caption={`${caption} by muscle group`} rowHeader="Muscle" order="muscle" columns={muscles} />
      ) : (
        <SetVolumeTable
          caption={`${caption} by movement pattern`}
          rowHeader="Pattern"
          order="pattern"
          columns={patterns}
        />
      )}
    </div>
  );
}
