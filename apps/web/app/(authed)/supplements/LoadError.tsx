'use client';

import { useEffect } from 'react';
import { logClientError } from '@/lib/log-client-error';

/** The error state when the stack can't be fetched. Reports the failure once, from the browser. */
export default function LoadError({ message }: { message: string }) {
  useEffect(() => {
    logClientError('supplements.load', new Error(message));
  }, [message]);
  return <p role="alert">Couldn’t load your supplements. Try again in a moment.</p>;
}
