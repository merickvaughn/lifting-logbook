// The lifter's linked Google Sheet, as `/integrations/google-sheet` returns it (#1432, ADR-047).

export type GoogleSheetLinkStatus = 'linked' | 'needs_relink' | 'sheet_missing';

export interface GoogleSheetLinkView {
  /** False when the API has no Google client or token key, so Settings hides the section. */
  configured: boolean;
  status: GoogleSheetLinkStatus | 'unlinked';
  spreadsheetUrl: string | null;
  lastMirroredAt: string | null;
}

export interface GoogleSheetUnlinkResult {
  revoked: boolean;
  /** Set when the revoke failed, so the lifter can remove access there. */
  permissionsUrl?: string;
}
