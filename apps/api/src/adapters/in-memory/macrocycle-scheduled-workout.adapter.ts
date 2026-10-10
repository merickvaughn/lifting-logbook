import { IMacrocycleScheduledWorkoutRepository, ScheduledWorkout } from '../../ports/IMacrocycleScheduledWorkoutRepository';

export class InMemoryMacrocycleScheduledWorkoutRepository implements IMacrocycleScheduledWorkoutRepository {
  private readonly store = new Map<string, ScheduledWorkout[]>();

  private key(program: string, macrocycleNum: number): string {
    return `${program}:${macrocycleNum}`;
  }

  async getScheduledWorkouts(program: string, macrocycleNum: number): Promise<ScheduledWorkout[]> {
    return this.store.get(this.key(program, macrocycleNum)) ?? [];
  }

  async saveScheduledWorkouts(program: string, macrocycleNum: number, workouts: ScheduledWorkout[]): Promise<void> {
    this.store.set(this.key(program, macrocycleNum), [...workouts]);
  }
}
