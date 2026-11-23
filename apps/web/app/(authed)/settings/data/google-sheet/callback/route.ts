import { ApiClientError } from '@lifting-logbook/api-client';
import { completeGoogleSheetLink } from '@/lib/api';
import {
  GOOGLE_SHEET_NOTICE_PARAM,
  googleSheetErrorName,
  type GoogleSheetNoticeCode,
} from '../../googleSheetNotice';

// Where Google sends the lifter back after the consent screen (#1433, ADR-047). It posts `code`
// and `state` to the API under the lifter's Clerk session, then redirects to Settings > Data with
// a fixed result code instead of the query, which holds the single-use code. The query is also
// removed from this request's trace spans (lib/scrub-callback-span.ts, decision 26).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SETTINGS_DATA = '/settings/data';

function back(result: GoogleSheetNoticeCode): Response {
  // A relative Location: the request's own origin may be an internal one behind Cloud Run.
  return new Response(null, {
    status: 303,
    headers: { Location: `${SETTINGS_DATA}?${GOOGLE_SHEET_NOTICE_PARAM}=${result}`, 'Cache-Control': 'no-store' },
  });
}

/** The API's error codes, mapped to what the lifter can do about them. */
function failureOf(err: unknown): GoogleSheetNoticeCode {
  const name = googleSheetErrorName(err);
  if (name === 'google-sheet-state-invalid') return 'expired';
  if (name === 'google-sheet-scope-not-granted') return 'scope';
  return 'failed';
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');
  // Google's `error` (such as access_denied) means the lifter said no, or Google refused.
  if (params.has('error')) return back('denied');
  if (!code || !state) return back('expired');
  try {
    await completeGoogleSheetLink(code, state);
    return back('linked');
  } catch (err) {
    // Its status and the API's error name only: nothing here needs more to say what happened.
    console.error('[google-sheet-callback] link failed', {
      status: err instanceof ApiClientError ? err.status : undefined,
      error: googleSheetErrorName(err),
    });
    return back(failureOf(err));
  }
}
