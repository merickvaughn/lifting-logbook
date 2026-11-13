import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LiftRecord, toUTCMidnight } from '@lifting-logbook/core';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import { RepositoryBundle } from '../ports/factory';
import { MacrocycleRow } from '../ports/IMacrocycleRepository';

/**
 * Non-cycle workouts (proposal 2026-11-06, decision 23, #1184): sets under the reserved program
 * `non-cycle`, in its one macrocycle, which is never renumbered.
 */
export const NON_CYCLE_MACROCYCLE_NUM = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The latest day a non-cycle set can be dated: one day past the server's UTC day. No timezone
 * is stored, so this leaves room for a lifter ahead of UTC.
 */
export function latestNonCycleDay(now: Date = new Date()): Date {
  return new Date(toUTCMidnight(now).getTime() + DAY_MS);
}

/**
 * A non-cycle set's date, from the client's local calendar day, up to
 * {@link latestNonCycleDay}. Anything later gets a 400.
 */
export function nonCycleDate(date: string | undefined, now: Date = new Date()): Date {
  if (!date) throw new BadRequestException('A non-cycle workout needs its date.');
  const day = toUTCMidnight(new Date(date));
  if (Number.isNaN(day.getTime())) throw new BadRequestException('date must be a valid calendar date');
  if (day.getTime() > latestNonCycleDay(now).getTime()) {
    throw new BadRequestException(`date ${date} is in the future. A non-cycle workout is recorded on or before today.`);
  }
  return day;
}

/** Every non-cycle set the user has. */
export function nonCycleRecords(repos: Pick<RepositoryBundle, 'liftRecord'>): Promise<LiftRecord[]> {
  return repos.liftRecord.getLiftRecords(NON_CYCLE_PROGRAM, NON_CYCLE_MACROCYCLE_NUM);
}

/** One workout's sets, in lift then set order, or a 404 when it has none. */
export async function nonCycleWorkout(
  repos: Pick<RepositoryBundle, 'liftRecord'>,
  workoutNum: number,
): Promise<[LiftRecord, ...LiftRecord[]]> {
  const [first, ...rest] = (
    await repos.liftRecord.getLiftRecords(NON_CYCLE_PROGRAM, NON_CYCLE_MACROCYCLE_NUM, workoutNum)
  ).sort((a, b) => a.lift.localeCompare(b.lift) || (a.occurrence ?? 0) - (b.occurrence ?? 0) || a.setNum - b.setNum);
  if (!first) throw new NotFoundException(`Non-cycle workout ${workoutNum} not found`);
  return [first, ...rest];
}

/**
 * Checks a set logged into a started non-cycle workout through `POST lift-records`: the workout
 * must exist, since only starting one takes a number, and the set takes its date, since order
 * comes from the date. Dates follow {@link nonCycleDate}.
 */
export async function assertNonCycleSet(
  repos: Pick<RepositoryBundle, 'liftRecord'>,
  workoutNum: number,
  date: string | undefined,
): Promise<void> {
  const day = nonCycleDate(date);
  const [first] = await nonCycleWorkout(repos, workoutNum);
  if (first.date.getTime() !== day.getTime()) {
    throw new BadRequestException(
      `Non-cycle workout ${workoutNum} is on ${first.date.toISOString().slice(0, 10)}, and each of its sets takes that date.`,
    );
  }
}

/**
 * The non-cycle macrocycle's row, created on first use with origin `non-cycle` and status
 * `unknown`, dated by the first workout it holds. A concurrent request creating it too is no
 * conflict, as with `ensureCurrentRow`.
 */
export async function ensureNonCycleRow(
  repos: Pick<RepositoryBundle, 'macrocycle'>,
  firstDate: Date,
): Promise<MacrocycleRow> {
  const find = () => repos.macrocycle.findByNumber(NON_CYCLE_PROGRAM, NON_CYCLE_MACROCYCLE_NUM);
  const row = await find();
  if (row) return row;
  await repos.macrocycle.ensure([
    {
      program: NON_CYCLE_PROGRAM,
      macrocycleNum: NON_CYCLE_MACROCYCLE_NUM,
      startDate: toUTCMidnight(firstDate),
      status: 'unknown',
      origin: 'non-cycle',
    },
  ]);
  const created = await find();
  if (!created) throw new Error('the non-cycle macrocycle row was not created');
  return created;
}

/**
 * The non-cycle macrocycle's row, for reading a workout. Starting or importing a workout creates
 * it, so a workout with sets always has one, and a missing row is a server error.
 */
export async function nonCycleRow(repos: Pick<RepositoryBundle, 'macrocycle'>): Promise<MacrocycleRow> {
  const row = await repos.macrocycle.findByNumber(NON_CYCLE_PROGRAM, NON_CYCLE_MACROCYCLE_NUM);
  if (!row) throw new Error('a non-cycle workout has sets but no macrocycle row');
  return row;
}

/**
 * The number a new non-cycle workout takes: one past every stored one, so two on one date stay
 * separate. The caller holds the macrocycle lock exclusively, so no other request takes it too.
 */
export async function nextNonCycleWorkoutNum(repos: Pick<RepositoryBundle, 'liftRecord'>): Promise<number> {
  const nums = await repos.liftRecord.getLoggedWorkoutNums(NON_CYCLE_PROGRAM, NON_CYCLE_MACROCYCLE_NUM);
  return Math.max(0, ...nums) + 1;
}
