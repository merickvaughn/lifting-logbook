import { createHash } from 'node:crypto';

export const SHEET_MIRROR_QUEUE = Symbol('SHEET_MIRROR_QUEUE');
export const MIRROR_PATH = '/internal/supplement-sheet-mirror';
/** ADR-047, decision 16: the debounce window. */
export const WINDOW_MS = 30_000;
const TIMEOUT_MS = 2_000;
const METADATA = 'http://metadata.google.internal/computeMetadata/v1';

export interface ISheetMirrorQueue {
  /**
   * Enqueues one run for the user, scheduled at the end of the 30-second window `now` falls in.
   * Every call in a window names the same task, so Cloud Tasks keeps one; `ALREADY_EXISTS` counts
   * as success (decisions 16-17). Throws on any other failure.
   */
  enqueue(userId: string, now?: Date): Promise<void>;
}

/** The task name for a user and window (decision 16). The hash keeps the user ID out of the name. */
export const taskName = (userId: string, window: number) =>
  `${createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 32)}-${window}`;

/**
 * Cloud Tasks over REST, authenticated as the service's own account through the metadata server,
 * as the KMS wrapper does, so no client library is needed. Its configuration comes from the
 * environment at call time; a missing value throws, which the caller logs.
 */
export class CloudTasksSheetMirrorQueue implements ISheetMirrorQueue {
  private async metadata(path: string): Promise<string> {
    const res = await fetch(`${METADATA}/${path}`, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`metadata ${path}: ${res.status}`);
    return res.text();
  }

  async enqueue(userId: string, now: Date = new Date()): Promise<void> {
    const queue = process.env.SHEET_MIRROR_QUEUE;
    const location = process.env.SHEET_MIRROR_QUEUE_LOCATION;
    const serviceAccountEmail = process.env.SHEET_MIRROR_TASKS_SA_EMAIL;
    const apiUrl = process.env.SHEET_MIRROR_API_URL?.replace(/\/$/, '');
    if (!queue || !location || !serviceAccountEmail || !apiUrl) throw new Error('the sheet mirror queue is not configured');

    const window = Math.floor(now.getTime() / WINDOW_MS);
    const project = await this.metadata('project/project-id');
    const token = JSON.parse(await this.metadata('instance/service-accounts/default/token')) as { access_token?: string };
    const parent = `projects/${project}/locations/${location}/queues/${queue}`;
    const res = await fetch(`https://cloudtasks.googleapis.com/v2/${parent}/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.access_token ?? ''}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        task: {
          name: `${parent}/tasks/${taskName(userId, window)}`,
          scheduleTime: new Date((window + 1) * WINDOW_MS).toISOString(),
          httpRequest: {
            httpMethod: 'POST',
            url: `${apiUrl}${MIRROR_PATH}`,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ userId })).toString('base64'),
            oidcToken: { serviceAccountEmail, audience: apiUrl },
          },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 409 is ALREADY_EXISTS: another change in this window already enqueued the run.
    if (res.ok || res.status === 409) return;
    // The status only: the body could echo the request.
    throw new Error(`Cloud Tasks create: ${res.status}`);
  }
}
