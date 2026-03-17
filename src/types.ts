export interface UserProfile {
  uid: string;
  displayName?: string;
  email?: string;
  garminConnected: boolean;
  garminToken?: string;
  garminUserId?: string;
  lastSync?: string;
  summary30d?: {
    totalDistance: number;
    avgPace: number;
    paceByEffect: {
      Threshold?: number;
      Marathon?: number;
      Tempo?: number;
      Recovery?: number;
      Easy?: number;
    };
    hrByEffect: {
      Threshold?: number;
      Marathon?: number;
      Tempo?: number;
      Recovery?: number;
      Easy?: number;
    };
    activityCount: number;
    avgHRV: number;
    lastUpdated: string;
  };
  coachInsights?: string;
}

export interface Activity {
  uid: string;
  activityId: string;
  type: "RUNNING" | "TRAIL_RUNNING";
  activityName?: string;
  startTime: string;
  distance: number;
  duration: number;
  averageHeartRate?: number;
  maxHeartRate?: number;
  elevationGain?: number;
  pace: number;
  vo2Max?: number;
  trainingEffect?: "Threshold" | "Marathon" | "Tempo" | "Recovery" | "Easy";
  eph?: number;
}

export interface HealthMetric {
  uid: string;
  date: string;
  restingHeartRate?: number;
  hrv?: number;
  sleepScore?: number;
  stressLevel?: number;
}

export interface ChatMessage {
  role: "user" | "model";
  text: string;
}
