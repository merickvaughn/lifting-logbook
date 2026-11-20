// Times of day are 24-hour `HH:MM` strings with both digits of the hour: '09:00', not '9:00'
// or '9:00 AM'. They are compared as minutes after midnight, never as strings.

const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isClockTime(time: string): boolean {
  return CLOCK_TIME.test(time);
}

/** `'14:30'` → 870. Throws on anything that isn't 24-hour `HH:MM`. */
export function minutesOfDay(time: string): number {
  const match = CLOCK_TIME.exec(time);
  if (!match) throw new RangeError(`Not a 24-hour HH:MM time: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}
