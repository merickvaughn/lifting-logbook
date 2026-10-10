export const AnalyticsEvent = {
  // Workout logging
  WORKOUT_STARTED:        'workout_started',
  WORKOUT_COMPLETED:      'workout_completed',
  WORKOUT_ABANDONED:      'workout_abandoned',
  SET_LOGGED:             'set_logged',

  // Navigation
  SCREEN_VIEWED:          'screen_viewed',

  // Training maxes
  TRAINING_MAXES_UPDATED: 'training_maxes_updated',

  // Macrocycle management
  MACROCYCLE_STARTED:          'macrocycle_started',
  MACROCYCLE_DASHBOARD_VIEWED: 'macrocycle_dashboard_viewed',
} as const;

export type AnalyticsEventName = typeof AnalyticsEvent[keyof typeof AnalyticsEvent];

export interface EventProperties {
  workout_started:        { lift: string; week: number; macrocycle: number; client: ClientType };
  workout_completed:      { lift: string; week: number; macrocycle: number; duration_seconds: number; client: ClientType };
  workout_abandoned:      { lift: string; week: number; macrocycle: number; client: ClientType };
  set_logged:             { lift: string; reps: number; weight: number; unit: 'lbs' | 'kg'; client: ClientType };
  screen_viewed:          { screen_name: string; client: ClientType };
  training_maxes_updated: { lift_count: number; client: ClientType };
  macrocycle_started:          { macrocycle: number; client: ClientType };
  macrocycle_dashboard_viewed: { macrocycle: number; client: ClientType };
}

export type ClientType = 'react_native' | 'kotlin_compose' | 'web';
