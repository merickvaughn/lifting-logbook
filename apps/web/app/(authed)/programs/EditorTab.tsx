'use client';

import { useState, useTransition } from 'react';
import { PROGRAMS } from '@/lib/programs';
import type { BarbellComplexResponse, CustomProgramResponse, CustomProgramSummaryResponse } from '@lifting-logbook/types';
import { deleteCustomProgram, fetchCustomProgram } from './actions';
import ProgramEditor from './ProgramEditor';
import styles from './programs.module.css';

type EditorMode = 'new' | 'clone' | 'edit';

type Props = {
  activeProgram: string | null;
  defaultWeightIncrement: number | null;
  customPrograms: CustomProgramSummaryResponse[];
  complexes: BarbellComplexResponse[] | null;
  onProgramSaved: (id: string) => void;
};

const ALL_TEMPLATES = PROGRAMS;

export default function EditorTab({
  activeProgram,
  defaultWeightIncrement,
  customPrograms: initialPrograms,
  complexes,
  onProgramSaved,
}: Props) {
  const [subTab, setSubTab] = useState<EditorMode>('new');
  const [editingProgram, setEditingProgram] = useState<CustomProgramResponse | null>(null);
  const [cloneTemplateId, setCloneTemplateId] = useState<string>(ALL_TEMPLATES[0]?.id ?? '');
  const [programs, setPrograms] = useState(initialPrograms);
  const [isDeleting, startDelete] = useTransition();
  const [, startFetch] = useTransition();
  const [fetchingId, setFetchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  function handleSaved(id: string) {
    onProgramSaved(id);
    setEditingProgram(null);
    setSubTab('new');
  }

  function handleDeleteConfirmed(id: string) {
    setConfirmingDeleteId(null);
    setError(null);
    startDelete(async () => {
      try {
        await deleteCustomProgram(id);
        setPrograms((prev) => prev.filter((p) => p.id !== id));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to delete program.');
      }
    });
  }

  function handleEditClick(id: string) {
    setError(null);
    setFetchingId(id);
    startFetch(async () => {
      try {
        const full = await fetchCustomProgram(id);
        setEditingProgram(full);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load program.');
      } finally {
        setFetchingId(null);
      }
    });
  }

  if (editingProgram) {
    return (
      <ProgramEditor
        mode="edit"
        existing={editingProgram}
        activeProgram={activeProgram}
        defaultWeightIncrement={defaultWeightIncrement}
        complexes={complexes}
        onSaved={handleSaved}
        onCancel={() => setEditingProgram(null)}
      />
    );
  }

  return (
    <div>
      <div className={styles.subTabs}>
        {(['new', 'clone', 'edit'] as EditorMode[]).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`${styles.subTab} ${subTab === tab ? styles.subTabActive : ''}`}
            onClick={() => { setSubTab(tab); setError(null); }}
          >
            {tab === 'new' ? 'New Program' : tab === 'clone' ? 'Clone Template' : 'Edit Custom'}
          </button>
        ))}
      </div>

      {error && <p className={styles.errorNote}>{error}</p>}

      {subTab === 'new' && (
        <ProgramEditor
          mode="new"
          activeProgram={activeProgram}
          defaultWeightIncrement={defaultWeightIncrement}
          complexes={complexes}
          onSaved={handleSaved}
          onCancel={() => {}}
        />
      )}

      {subTab === 'clone' && (
        <div>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="clone-template">Template to Clone</label>
            <select
              id="clone-template"
              className={styles.formSelect}
              value={cloneTemplateId}
              onChange={(e) => setCloneTemplateId(e.target.value)}
            >
              {ALL_TEMPLATES.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div style={{ marginTop: '1rem' }}>
            <ProgramEditor
              key={cloneTemplateId}
              mode="clone"
              baseTemplateId={cloneTemplateId}
              activeProgram={activeProgram}
              defaultWeightIncrement={defaultWeightIncrement}
              complexes={complexes}
              onSaved={handleSaved}
              onCancel={() => setSubTab('new')}
            />
          </div>
        </div>
      )}

      {subTab === 'edit' && (
        <div>
          {programs.length === 0 ? (
            <p className={styles.emptyState}>No custom programs yet. Create one in the New Program tab.</p>
          ) : (
            <div className={styles.customProgramList}>
              {programs.map((p) => (
                <div key={p.id} className={styles.customProgramItem}>
                  <div style={{ flex: 1 }}>
                    <span className={styles.customProgramName}>{p.name}</span>
                    {p.description && (
                      <span className={styles.customProgramMeta}> — {p.description}</span>
                    )}
                    {p.id === activeProgram && (
                      <span className={styles.currentBadge} style={{ marginLeft: '0.5rem' }}>Active</span>
                    )}
                  </div>
                  <div className={styles.programActions} style={{ marginTop: 0 }}>
                    {confirmingDeleteId === p.id ? (
                      <>
                        <span className={styles.infoText} style={{ marginBottom: 0 }}>Delete permanently?</span>
                        <button
                          type="button"
                          className={styles.btnDanger}
                          onClick={() => handleDeleteConfirmed(p.id)}
                          disabled={isDeleting}
                        >
                          {isDeleting ? 'Deleting…' : 'Yes, delete'}
                        </button>
                        <button
                          type="button"
                          className={styles.btnSecondary}
                          onClick={() => setConfirmingDeleteId(null)}
                          disabled={isDeleting}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={styles.btnSecondary}
                          onClick={() => handleEditClick(p.id)}
                          disabled={fetchingId !== null || isDeleting}
                        >
                          {fetchingId === p.id ? 'Loading…' : 'Edit'}
                        </button>
                        <button
                          type="button"
                          className={styles.btnDanger}
                          onClick={() => setConfirmingDeleteId(p.id)}
                          disabled={isDeleting || fetchingId !== null}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
