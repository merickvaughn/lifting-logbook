'use server';

import { revalidatePath } from 'next/cache';
import { deleteStrengthGoal, recordBodyWeight, upsertStrengthGoal } from '@/lib/api';
import { getUserToday } from '@/lib/userToday';
import type { StrengthGoalResponse, UpsertStrengthGoalRequest } from '@lifting-logbook/types';

export async function saveStrengthGoal(
  program: string,
  lift: string,
  body: UpsertStrengthGoalRequest,
): Promise<StrengthGoalResponse> {
  const result = await upsertStrengthGoal(program, lift, body);
  revalidatePath('/settings/strength-goals');
  return result;
}

export async function removeStrengthGoal(
  program: string,
  lift: string,
): Promise<void> {
  await deleteStrengthGoal(program, lift);
  revalidatePath('/settings/strength-goals');
}

export async function saveBodyWeight(
  program: string,
  weight: number,
  unit: 'lbs' | 'kg',
): Promise<void> {
  const today = await getUserToday();
  await recordBodyWeight(program, { date: today, weight, unit });
  revalidatePath('/settings/strength-goals');
}
