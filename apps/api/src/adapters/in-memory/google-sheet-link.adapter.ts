import {
  GoogleOauthRequestRecord,
  GoogleSheetLinkRecord,
  IGoogleSheetLinkRepository,
} from '../../ports/IGoogleSheetLinkRepository';

export class InMemoryGoogleSheetLinkRepository implements IGoogleSheetLinkRepository {
  private link: GoogleSheetLinkRecord | null = null;
  private request: GoogleOauthRequestRecord | null = null;

  async getLink(): Promise<GoogleSheetLinkRecord | null> {
    return this.link && { ...this.link };
  }

  async saveLink(link: Omit<GoogleSheetLinkRecord, 'lastMirroredAt'>): Promise<void> {
    this.link = { ...link, lastMirroredAt: this.link?.lastMirroredAt ?? null };
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

  /** For tests: sets a stored link's status, as a mirror run would (decisions 11-12). */
  setStatusForTest(status: GoogleSheetLinkRecord['status']): void {
    if (!this.link) throw new Error('no link');
    this.link = { ...this.link, status, ...(status === 'needs_relink' && { token: null }) };
  }
}
