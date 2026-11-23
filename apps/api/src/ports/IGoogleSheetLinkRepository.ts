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
  /** The highest `supplement_change.seq` the mirror wrote (decision 19), or null before its first run. */
  lastMirroredSeq: number | null;
}

/** What `saveLink` writes: the mirror's own columns are the mirror's to set. */
export type GoogleSheetLinkInput = Omit<GoogleSheetLinkRecord, 'lastMirroredAt' | 'lastMirroredSeq'>;

/**
 * A lease one mirror run took (decision 19). Every later write of that run names it, and does
 * nothing once the row no longer holds it: the lifter unlinked, linked another sheet, or the lease
 * expired and another run took it.
 */
export interface MirrorLease {
  spreadsheetId: string;
  /** The `mirrorLeaseUntil` this run set, compared exactly. */
  until: Date;
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
  saveLink(link: GoogleSheetLinkInput): Promise<void>;
  deleteLink(): Promise<void>;
  /**
   * Takes the mirror lease on the link to `spreadsheetId` for five minutes, by the database's
   * clock (ADR-047, decision 19). Null when another run holds it, or there is no link to that
   * sheet.
   */
  takeMirrorLease(spreadsheetId: string): Promise<MirrorLease | null>;
  /**
   * Releases `lease` if the row still holds it, recording `errorCode` as the last error when given.
   * Never creates a row.
   */
  releaseMirrorLease(lease: MirrorLease, errorCode?: string): Promise<void>;
  /**
   * Records a finished run if the row still holds `lease`: `lastMirroredSeq` (never lowered),
   * `lastMirroredAt`, no last error, and releases the lease. False, with nothing written, when the
   * row no longer holds it. Never creates a row.
   */
  recordMirrored(lease: MirrorLease, seq: number): Promise<boolean>;
  /**
   * Google refused the token whose nonce is `tokenNonce` (decision 11): sets `needs_relink`, the
   * `invalid_grant` code and no token on the link to `spreadsheetId`, only while it still holds
   * that token. Never creates a row, and leaves a link the lifter made since untouched.
   */
  markNeedsRelink(spreadsheetId: string, tokenNonce: Buffer): Promise<void>;
  /**
   * The sheet is gone (decision 12): sets `sheet_missing` on the `linked` link to `spreadsheetId`.
   * Never creates a row, and leaves a link to another sheet untouched.
   */
  markSheetMissing(spreadsheetId: string): Promise<void>;
  /** Replaces any earlier attempt. */
  putOauthRequest(request: GoogleOauthRequestRecord): Promise<void>;
  /** Returns the user's attempt and deletes it, so a state is used at most once. */
  takeOauthRequest(): Promise<GoogleOauthRequestRecord | null>;
}
