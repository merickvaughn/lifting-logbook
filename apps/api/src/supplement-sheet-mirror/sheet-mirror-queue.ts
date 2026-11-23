import { createHash } from 'node:crypto';

export const SHEET_MIRROR_QUEUE = Symbol('SHEET_MIRROR_QUEUE');
export const MIRROR_PATH = '/internal/supplement-sheet-mirror';
/** ADR-047, decision 16: the debounce window. */
export const WINDOW_MS = 30_000;
/** ADR-047, decision 16: the whole enqueue, every call in it, gets this long. */
export const ENQUEUE_TIMEOUT_MS = 2_000;
/** A cached access token is fetched again this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const METADATA = 'http://metadata.google.internal/computeMetadata/v1';

/** `change` runs at the end of the window; `sync` is Sync now's own task, scheduled at once (decision 16). */
export type MirrorTaskKind = 'change' | 'sync';

/** A Cloud Tasks call that failed: the HTTP status only, since the response body could echo the request. */
export class CloudTasksError extends Error {
  constructor(readonly status: number) {
    super(`Cloud Tasks create: ${status}`);
    this.name = 'CloudTasksError';
  }
}

export interface ISheetMirrorQueue {
  /**
   * Enqueues one run for the user. A `change` task is scheduled at the end of the 30-second window
   * `now` falls in; a `sync` task runs at once. Every call of one kind in a window names the same
   * task, so Cloud Tasks keeps one; `ALREADY_EXISTS` counts as success (decisions 16-17). Throws on
   * any other failure.
   */
  enqueue(userId: string, now?: Date, kind?: MirrorTaskKind): Promise<void>;
}

/** The task name for a user and window (decision 16). The hash keeps the user ID out of the name. */
export const taskName = (userId: string, window: number, kind: MirrorTaskKind = 'change') =>
  `${createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 32)}-${kind === 'sync' ? 'sync-' : ''}${window}`;

/**
 * Cloud Tasks over REST, authenticated as the service's own account through the metadata server,
 * as the KMS wrapper does, so no client library is needed. Its configuration comes from the
 * environment at call time; a missing value throws, which the caller logs. Decision 16's 2 s
 * timeout covers the whole enqueue, not each call, and the project ID and access token are cached
 * (the token until a minute before it expires), so a warm instance makes one call per enqueue.
 */
export class CloudTasksSheetMirrorQueue implements ISheetMirrorQueue {
  private projectId?: string;
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly clock: () => number = Date.now,
  ) {}

  private async metadata(path: string, signal: AbortSignal): Promise<string> {
    const res = await this.fetchImpl(`${METADATA}/${path}`, { headers: { 'Metadata-Flavor': 'Google' }, signal });
    if (!res.ok) throw new Error(`metadata ${path}: ${res.status}`);
    return res.text();
  }

  private async project(signal: AbortSignal): Promise<string> {
    this.projectId ??= (await this.metadata('project/project-id', signal)).trim();
    return this.projectId;
  }

  private async accessToken(signal: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.clock()) return this.token.value;
    const body = JSON.parse(await this.metadata('instance/service-accounts/default/token', signal)) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) throw new Error('metadata token: no access_token');
    this.token = { value: body.access_token, expiresAt: this.clock() + (body.expires_in ?? 0) * 1000 };
    return this.token.value;
  }

  async enqueue(userId: string, now: Date = new Date(), kind: MirrorTaskKind = 'change'): Promise<void> {
    const queue = process.env.SHEET_MIRROR_QUEUE;
    const location = process.env.SHEET_MIRROR_QUEUE_LOCATION;
    const serviceAccountEmail = process.env.SHEET_MIRROR_TASKS_SA_EMAIL;
    const apiUrl = process.env.SHEET_MIRROR_API_URL?.replace(/\/$/, '');
    if (!queue || !location || !serviceAccountEmail || !apiUrl) throw new Error('the sheet mirror queue is not configured');

    const signal = AbortSignal.timeout(ENQUEUE_TIMEOUT_MS);
    const window = Math.floor(now.getTime() / WINDOW_MS);
    const project = await this.project(signal);
    const token = await this.accessToken(signal);
    const parent = `projects/${project}/locations/${location}/queues/${queue}`;
    const res = await this.fetchImpl(`https://cloudtasks.googleapis.com/v2/${parent}/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        task: {
          name: `${parent}/tasks/${taskName(userId, window, kind)}`,
          scheduleTime: new Date(kind === 'sync' ? now.getTime() : (window + 1) * WINDOW_MS).toISOString(),
          httpRequest: {
            httpMethod: 'POST',
            url: `${apiUrl}${MIRROR_PATH}`,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ userId })).toString('base64'),
            oidcToken: { serviceAccountEmail, audience: apiUrl },
          },
        },
      }),
      signal,
    });
    // 409 is ALREADY_EXISTS: another change in this window already enqueued the run.
    if (res.ok || res.status === 409) return;
    throw new CloudTasksError(res.status);
  }
}
