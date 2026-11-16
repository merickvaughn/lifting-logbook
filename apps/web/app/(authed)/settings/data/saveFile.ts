// A browser may start the download after the click returns, and iOS Safari fails if the URL is
// gone by then. FileSaver.js waits this long for the same reason.
const REVOKE_DELAY_MS = 40_000;

/** Hands the browser a file to save. */
export function saveFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/** What a failed request shows. The browser's own text for a timeout is about an aborted operation. */
export function failureMessage(err: unknown, timedOut: string, fallback: string): string {
  if (err instanceof Error && err.name === 'TimeoutError') return timedOut;
  return err instanceof Error && err.message ? err.message : fallback;
}
