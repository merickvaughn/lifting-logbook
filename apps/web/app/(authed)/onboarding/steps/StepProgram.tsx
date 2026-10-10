'use client';

import { useCallback, useMemo, useState } from 'react';
import styles from '../onboarding.module.css';
import { PROGRAMS, type Experience, type Goal, type Program, type Purpose } from '@/lib/programs';

const EXPERIENCE_LEVELS: Experience[] = ['beginner', 'intermediate', 'advanced'];

const GOAL_OPTIONS: { label: string; value: 'all' | Goal }[] = [
  { label: 'All', value: 'all' },
  { label: '💪 Strength', value: 'strength' },
  { label: '📈 Muscle Gain', value: 'muscle-gain' },
  { label: '⚖️ Body Composition', value: 'body-composition' },
  { label: '🔥 Fat Loss', value: 'fat-loss' },
];

const PURPOSE_COLORS: Record<Purpose, string> = {
  Strength: '#e74c3c',
  Hypertrophy: '#3498db',
  Bodybuilding: '#9b59b6',
  Powerlifting: '#c0392b',
  Sports: '#27ae60',
  Beginner: '#27ae60',
  Intermediate: '#f39c12',
};

type View = 'list' | 'detail' | 'catalog';

type Props = {
  experience: Experience;
  selectedProgramId: string | null;
  onExperienceChange: (level: Experience) => void;
  onSelectProgram: (id: string) => void;
  onClearSelection: () => void;
  onAdvance: () => void;
};

export function StepProgram({
  experience,
  selectedProgramId,
  onExperienceChange,
  onSelectProgram,
  onClearSelection,
  onAdvance,
}: Props) {
  const [view, setView] = useState<View>('list');
  const [goalFilter, setGoalFilter] = useState<'all' | Goal>('all');
  // Unavailable ("coming soon") presets are hidden by default; this toggle reveals
  // them. Revealed presets stay non-selectable — see the detail view's availability
  // gate (Choose This Program is disabled when !isAvailable).
  const [showUnavailable, setShowUnavailable] = useState(false);

  const selectedProgram: Program | null =
    PROGRAMS.find((p) => p.id === selectedProgramId) ?? null;

  const applyFilters = useCallback(
    (programs: Program[]) =>
      programs.filter((p) => {
        if (!showUnavailable && !p.available) return false;
        if (goalFilter !== 'all' && !p.goals.includes(goalFilter)) return false;
        return true;
      }),
    [goalFilter, showUnavailable],
  );

  const visiblePrograms = useMemo(
    () => applyFilters(PROGRAMS.filter((p) => p.experience === experience)),
    [experience, applyFilters],
  );

  const catalogByTier = useMemo(
    () => ({
      beginner: applyFilters(PROGRAMS.filter((p) => p.experience === 'beginner')),
      intermediate: applyFilters(PROGRAMS.filter((p) => p.experience === 'intermediate')),
      advanced: applyFilters(PROGRAMS.filter((p) => p.experience === 'advanced')),
    }),
    [applyFilters],
  );

  // When the default-on availability filter hides every match for the current
  // experience/goal, the empty state points at the toggle instead of implying no
  // program exists (the onboarding default tier is 'beginner', whose presets are
  // all unavailable today).
  const hiddenUnavailableCount = useMemo(
    () =>
      showUnavailable
        ? 0
        : PROGRAMS.filter(
            (p) =>
              p.experience === experience &&
              !p.available &&
              (goalFilter === 'all' || p.goals.includes(goalFilter)),
          ).length,
    [experience, goalFilter, showUnavailable],
  );

  // Catalog-view variant of the count above: it spans every experience tier, so
  // it must not be scoped to the current `experience` (unlike the list view).
  const catalogHiddenUnavailableCount = useMemo(
    () =>
      showUnavailable
        ? 0
        : PROGRAMS.filter(
            (p) => !p.available && (goalFilter === 'all' || p.goals.includes(goalFilter)),
          ).length,
    [goalFilter, showUnavailable],
  );

  function handleSelectProgram(id: string) {
    onSelectProgram(id);
    setView('detail');
  }

  function handleBack() {
    onClearSelection();
    setView('list');
  }

  function handleBackFromCatalog() {
    setView('list');
  }

  function handleExperienceChange(level: Experience) {
    onExperienceChange(level);
    setView('list');
  }

  // --- Goal filter bar (shared between list and catalog views) ---
  const goalFilterBar = (
    <div className={styles.goalFilter} role="group" aria-label="Goal filter">
      {GOAL_OPTIONS.map(({ label, value }) => {
        const cls = [
          styles.goalChip,
          goalFilter === value ? styles.goalChipActive : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <button
            key={value}
            type="button"
            className={cls}
            aria-pressed={goalFilter === value}
            onClick={() => setGoalFilter(value)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );

  // --- Availability toggle (shared between list and catalog views) ---
  const availabilityToggle = (
    <div className={styles.availabilityToggleRow}>
      <button
        type="button"
        className={[styles.filterChip, showUnavailable ? styles.filterChipActive : '']
          .filter(Boolean)
          .join(' ')}
        aria-pressed={showUnavailable}
        onClick={() => setShowUnavailable((v) => !v)}
      >
        Show coming soon
      </button>
    </div>
  );

  // --- Program list item ---
  function programListItem(p: Program, onClick: () => void) {
    return (
      <button
        key={p.id}
        type="button"
        className={styles.programItem}
        onClick={onClick}
      >
        <span className={styles.programName}>{p.name}</span>
        <span className={styles.programMeta}>{p.meta}</span>
      </button>
    );
  }

  // --- Detail view ---
  if (selectedProgram && view === 'detail') {
    const isAvailable = selectedProgram.available;
    return (
      <>
        <h2 className={styles.stepTitle}>Program details</h2>

        <div className={styles.programDetail}>
          <div className={styles.programDetailHeader}>
            <h3 className={styles.programDetailName}>{selectedProgram.name}</h3>
            <span className={styles.programDetailMeta}>{selectedProgram.meta}</span>
          </div>

          <p className={styles.programDetailDescription}>
            {selectedProgram.description}
          </p>

          {/* Purpose tags */}
          <div className={styles.purposeTags}>
            {selectedProgram.purposes.map((tag) => (
              <span
                key={tag}
                className={styles.purposeTag}
                style={{ backgroundColor: PURPOSE_COLORS[tag] }}
              >
                {tag}
              </span>
            ))}
          </div>

          {/* Duration / frequency grid */}
          <div className={styles.metaGrid}>
            <div className={styles.metaCell}>
              <div className={styles.metaCellLabel}>Duration</div>
              <div className={styles.metaCellValue}>{selectedProgram.weeks}w</div>
            </div>
            <div className={styles.metaCell}>
              <div className={styles.metaCellLabel}>Frequency</div>
              <div className={styles.metaCellValue}>{selectedProgram.daysPerWeek}×/week</div>
            </div>
          </div>

          {/* Progression */}
          <p className={styles.sectionLabel}>Progression</p>
          <p className={styles.infoText}>{selectedProgram.progression}</p>

          {/* Deload strategy */}
          <p className={styles.sectionLabel}>Deload Strategy</p>
          <p className={styles.infoText}>{selectedProgram.deloads}</p>

          {/* Periodization */}
          <p className={styles.sectionLabel}>Periodization</p>
          <p className={styles.infoText}>{selectedProgram.periodization}</p>

          {/* Core lifts */}
          <p className={styles.sectionLabel}>Core Lifts</p>
          <div className={styles.liftsList}>
            {selectedProgram.lifts.map((lift) => (
              <span key={lift} className={styles.liftChip}>{lift}</span>
            ))}
          </div>

          {/* Sample schedule */}
          <p className={styles.sectionLabel}>Sample Schedule</p>
          <div className={styles.scheduleList}>
            {selectedProgram.schedule.map((day) => (
              <div key={day.day} className={styles.scheduleDay}>
                <span className={styles.scheduleDayName}>{day.day}</span>
                <ul className={styles.scheduleLiftList}>
                  {day.lifts.map((lift) => (
                    <li key={lift} className={styles.scheduleLift}>
                      {lift}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className={styles.detailActions}>
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={handleBack}
            >
              Back
            </button>
            <button
              type="button"
              className={styles.btnSuccess}
              onClick={isAvailable ? onAdvance : undefined}
              disabled={!isAvailable}
              aria-disabled={!isAvailable}
            >
              Choose This Program
            </button>
          </div>

          {!isAvailable && (
            <p className={styles.comingSoonNote}>⏳ Coming soon — not yet available</p>
          )}
        </div>
      </>
    );
  }

  // --- Full catalog view ---
  if (view === 'catalog') {

    return (
      <>
        <h2 className={styles.stepTitle}>Full catalog</h2>
        <p className={styles.stepHint}>All programs — filter by goal.</p>

        {goalFilterBar}

        {availabilityToggle}

        {EXPERIENCE_LEVELS.every((tier) => catalogByTier[tier].length === 0) ? (
          <p className={`${styles.stepHint} ${styles.emptyState}`}>
            {catalogHiddenUnavailableCount > 0
              ? `No available programs match this filter. Turn on “Show coming soon” to preview ${catalogHiddenUnavailableCount} in development.`
              : 'No programs match this filter.'}
          </p>
        ) : (
          EXPERIENCE_LEVELS.map((tier) => {
            const tierPrograms = catalogByTier[tier];
            if (tierPrograms.length === 0) return null;
            return (
              <div key={tier}>
                <p className={styles.catalogTierLabel}>
                  {tier.charAt(0).toUpperCase() + tier.slice(1)}
                </p>
                <div className={styles.programList}>
                  {tierPrograms.map((p) =>
                    programListItem(p, () => handleSelectProgram(p.id)),
                  )}
                </div>
              </div>
            );
          })
        )}

        <button
          type="button"
          className={`${styles.btnSecondary} ${styles.catalogBackBtn}`}
          onClick={handleBackFromCatalog}
        >
          Back
        </button>
      </>
    );
  }

  // --- Default: experience-filtered list view ---
  return (
    <>
      <h2 className={styles.stepTitle}>Choose a program</h2>
      <p className={styles.stepHint}>
        Filter by experience and goal, then pick a template to see details.
      </p>

      {/* Experience filter */}
      <div
        className={styles.experienceFilter}
        role="tablist"
        aria-label="Experience level"
      >
        {EXPERIENCE_LEVELS.map((level) => {
          const cls = [
            styles.filterChip,
            experience === level ? styles.filterChipActive : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={level}
              type="button"
              role="tab"
              aria-selected={experience === level}
              className={cls}
              onClick={() => handleExperienceChange(level)}
            >
              {level.charAt(0).toUpperCase() + level.slice(1)}
            </button>
          );
        })}
      </div>

      {/* Goal filter */}
      {goalFilterBar}

      {/* Availability toggle */}
      {availabilityToggle}

      {/* Program list */}
      <div className={styles.programList}>
        {visiblePrograms.length > 0 ? (
          visiblePrograms.map((p) =>
            programListItem(p, () => handleSelectProgram(p.id)),
          )
        ) : (
          <p className={`${styles.stepHint} ${styles.emptyState}`}>
            {hiddenUnavailableCount > 0
              ? `No available programs match this filter. Turn on “Show coming soon” to preview ${hiddenUnavailableCount} in development.`
              : 'No programs match this filter.'}
          </p>
        )}
      </div>

      {/* View full catalog */}
      <button
        type="button"
        className={`${styles.btnSecondary} ${styles.catalogLaunchBtn}`}
        onClick={() => setView('catalog')}
      >
        📚 View Full Catalog
      </button>
    </>
  );
}
