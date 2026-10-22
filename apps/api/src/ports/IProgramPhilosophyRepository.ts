export interface ProgramPhilosophy {
  programType: string;
  displayName: string;
  summary: string;
  progressionRules: string;
  trainingMaxGuidance: string;
  deloadGuidance: string;
  notes: string[];
  /**
   * How this app schedules the program, where that differs from the author's
   * text above. Wins over the author's text when the two conflict. Only programs
   * the app can schedule (`PROGRAM_LENGTHS`) carry one.
   */
  appModel?: string;
}

export interface IProgramPhilosophyRepository {
  getProgramPhilosophy(programType: string): Promise<ProgramPhilosophy | null>;
  listPrograms(): Promise<ProgramPhilosophy[]>;
}
