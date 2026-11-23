import {
  GoogleOauthRequestRecord,
  GoogleSheetLinkRecord,
  IGoogleSheetLinkRepository,
} from '../../ports/IGoogleSheetLinkRepository';
import { StoredRow } from '../../ports/IUserDataExportRepository';

export class InMemoryGoogleSheetLinkRepository implements IGoogleSheetLinkRepository {
  private link: (GoogleSheetLinkRecord & { createdAt: Date }) | null = null;
  private request: GoogleOauthRequestRecord | null = null;

  async getLink(): Promise<GoogleSheetLinkRecord | null> {
    if (!this.link) return null;
    const { createdAt: _createdAt, ...link } = this.link;
    return link;
  }

  async saveLink(link: Omit<GoogleSheetLinkRecord, 'lastMirroredAt'>): Promise<void> {
    // As google_sheet_link_token_check does: a token exactly when the status can use one.
    if ((link.status === 'needs_relink') !== (link.token === null)) {
      throw new Error(`google_sheet_link_token_check: status ${link.status} with${link.token ? '' : 'out'} a token`);
    }
    const sameSheet = this.link?.spreadsheetId === link.spreadsheetId;
    this.link = {
      status: link.status,
      spreadsheetId: link.spreadsheetId,
      spreadsheetUrl: link.spreadsheetUrl,
      grantedScope: link.grantedScope,
      token: link.token,
      lastErrorCode: link.lastErrorCode,
      lastMirroredAt: sameSheet ? (this.link?.lastMirroredAt ?? null) : null,
      createdAt: this.link?.createdAt ?? new Date(),
    };
  }

  async deleteLink(): Promise<void> {
    this.link = null;
  }

  async putOauthRequest(request: GoogleOauthRequestRecord): Promise<void> {
    this.request = { ...request };
  }

  async takeOauthRequest(): Promise<GoogleOauthRequestRecord | null> {
    const request = this.request;
    this.request = null;
    return request;
  }

  /** The columns Download My Data exports, as PrismaUserDataExportRepository selects them. */
  exportRows(): StoredRow[] {
    if (!this.link) return [];
    const { status, spreadsheetUrl, lastMirroredAt, createdAt } = this.link;
    return [{ status, spreadsheetUrl, lastMirroredAt, createdAt }];
  }
}
