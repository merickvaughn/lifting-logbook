'use client';

import { useState } from 'react';
import type { BarbellComplexResponse, CustomProgramSummaryResponse, UserWorkoutSchedule } from '@lifting-logbook/types';
import BrowseTab from './BrowseTab';
import EditorTab from './EditorTab';
import styles from './programs.module.css';

type Tab = 'browse' | 'editor';

type Props = {
  activeProgram: string | null;
  workoutSchedule: UserWorkoutSchedule | null;
  defaultWeightIncrement: number | null;
  customPrograms: CustomProgramSummaryResponse[];
  /** The lifter's complexes, which a program row can plan (#1495). */
  complexes: BarbellComplexResponse[];
};

export default function ProgramsTabs({
  activeProgram,
  workoutSchedule,
  defaultWeightIncrement,
  customPrograms,
  complexes,
}: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('browse');
  const [currentActive, _setCurrentActive] = useState(activeProgram);

  function handleProgramSaved(_id: string) {
    // Do not update currentActive here — saving a program does not switch to it.
    // currentActive updates only when the user explicitly switches via the Browse
    // tab dialog or Save & Switch, both of which navigate away from this page.
    setActiveTab('browse');
  }

  return (
    <>
      <div className={styles.tabs}>
        <button
          type="button"
          className={`${styles.tab} ${activeTab === 'browse' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('browse')}
        >
          Browse Programs
        </button>
        <button
          type="button"
          className={`${styles.tab} ${activeTab === 'editor' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('editor')}
        >
          My Programs
        </button>
      </div>

      {activeTab === 'browse' && (
        <BrowseTab activeProgram={currentActive} workoutSchedule={workoutSchedule} />
      )}

      {activeTab === 'editor' && (
        <EditorTab
          activeProgram={currentActive}
          defaultWeightIncrement={defaultWeightIncrement}
          customPrograms={customPrograms}
          complexes={complexes}
          onProgramSaved={handleProgramSaved}
        />
      )}
    </>
  );
}
