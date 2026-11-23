/** A refresh token envelope-encrypted as ADR-014 specifies (ADR-047, decision 7). */
export interface EncryptedToken {
  ciphertext: Buffer;
  /** The data key, wrapped by google-oauth-token-kek. */
  wrappedKey: Buffer;
  /** The 12-byte GCM nonce. */
  nonce: Buffer;
}

export type GoogleSheetLinkStatus = 'linked' | 'needs_relink' | 'sheet_missing';

/** The user's link (#1432). `token` is null only for `needs_relink`, as the table's check requires. */
export interface GoogleSheetLinkRecord {
  status: GoogleSheetLinkStatus;
  spreadsheetId: string;
  spreadsheetUrl: string;
  grantedScope: string;
  token: EncryptedToken | null;
  /** A code only, e.g. `invalid_grant` (decision 11); null once the link works again. */
  lastErrorCode: string | null;
  lastMirroredAt: Date | null;
}

/** The user's pending link attempt (decision 5). */
export interface GoogleOauthRequestRecord {
  stateHash: Buffer;
  codeVerifier: string;
  expiresAt: Date;
}

export interface IGoogleSheetLinkRepository {
  getLink(): Promise<GoogleSheetLinkRecord | null>;
  /**
   * Creates or replaces the user's link. It keeps the mirror's history (when it last ran, what it
   * last wrote, its lease) for the same spreadsheet, and starts it over for a different one, which
   * holds nothing yet. Rejects a token that doesn't match the status, as the table's check does.
   */
  saveLink(link: Omit<GoogleSheetLinkRecord, 'lastMirroredAt'>): Promise<void>;
  deleteLink(): Promise<void>;
  /**
   * Takes the mirror lease for two minutes (ADR-047, decision 19). False when another run holds it
   * or there is no link.
   */
  takeMirrorLease(): Promise<boolean>;
  /** Releases the lease after a failed run, recording `errorCode` as the last error when given. */
  releaseMirrorLease(errorCode?: string): Promise<void>;
  /** Records a finished run: `lastMirroredSeq`, `lastMirroredAt`, no last error, and releases the lease. */
  recordMirrored(seq: number): Promise<void>;
  /** Replaces any earlier attempt. */
  putOauthRequest(request: GoogleOauthRequestRecord): Promise<void>;
  /** Returns the user's attempt and deletes it, so a state is used at most once. */
  takeOauthRequest(): Promise<GoogleOauthRequestRecord | null>;
}
