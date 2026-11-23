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
  /** Creates or replaces the user's link, keeping its mirror history. */
  saveLink(link: Omit<GoogleSheetLinkRecord, 'lastMirroredAt'>): Promise<void>;
  deleteLink(): Promise<void>;
  /** Replaces any earlier attempt. */
  putOauthRequest(request: GoogleOauthRequestRecord): Promise<void>;
  /** Returns the user's attempt and deletes it, so a state is used at most once. */
  takeOauthRequest(): Promise<GoogleOauthRequestRecord | null>;
}
