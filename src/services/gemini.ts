import { GoogleGenAI } from "@google/genai";
import { Activity, HealthMetric } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function getCoachResponse(
  prompt: string,
  activities: Activity[],
  healthMetrics: HealthMetric[],
  history: { role: "user" | "model"; text: string }[],
  storedSummary?: any,
  coachInsights?: string
) {
  // Use stored summary or calculate on-the-fly as fallback
  const summary30d = storedSummary || (() => {
    const last30Days = activities.filter(a => {
      const date = new Date(a.startTime);
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      return date > thirtyDaysAgo;
    });

    return {
      totalDistance: last30Days.reduce((sum, a) => sum + a.distance, 0).toFixed(1),
      avgPace: (last30Days.reduce((sum, a) => sum + a.pace, 0) / (last30Days.length || 1)).toFixed(2),
      activityCount: last30Days.length,
      avgHRV: (healthMetrics.slice(0, 7).reduce((sum, m) => sum + (m.hrv || 0), 0) / (healthMetrics.slice(0, 7).length || 1)).toFixed(0)
    };
  })();

  const model = ai.models.generateContent({
    model: "gemini-3.1-pro-preview",
    config: {
      systemInstruction: `You are G-Coach, an expert AI running coach.
      You analyze Garmin data to provide personalized coaching.
      
      DATA MANAGEMENT STRATEGY:
      - To handle large volumes of data, you are provided with a 30-day AGGREGATED SUMMARY.
      - You also see the 10 most RECENT detailed activities to understand current form.
      - LONG-TERM MEMORY: You have access to "Coach Insights" which is a persistent summary of the user's training history, goals, and previous advice.
      
      COACH INSIGHTS (Long-term Memory):
      ${coachInsights || "No previous insights stored yet."}
      
      USER DATA SUMMARY (Last 30 Days):
      - Total Distance: ${summary30d.totalDistance} km
      - Avg Pace: ${summary30d.avgPace} min/km
      - Runs: ${summary30d.activityCount}
      - Avg HRV: ${summary30d.avgHRV} ms
      
      PACE & HR BY TRAINING TYPE:
      - Pace Breakdown (min/km): ${JSON.stringify(summary30d.paceByEffect || {})}
      - HR Breakdown (bpm): ${JSON.stringify(summary30d.hrByEffect || {})}
      
      RECENT DETAILED ACTIVITIES (Top 10):
      ${JSON.stringify(activities.slice(0, 10).map(a => ({
        date: a.startTime.split('T')[0],
        dist: a.distance,
        pace: a.pace,
        hr: a.averageHeartRate,
        te: a.trainingEffect,
        eph: a.eph
      })))}
      
      GOALS:
      1. Analyze training load and recovery.
      2. Suggest workouts based on the user's current fitness level.
      3. Predict race times using recent pace data.
      
      IMPORTANT: If you identify a significant change in the user's fitness or have a new long-term recommendation, include a section at the very end of your response starting with "NEW_INSIGHT:" followed by a concise summary of the user's current status to be remembered for next time.`,
    },
    contents: [
      ...history.slice(-6).map(h => ({ role: h.role, parts: [{ text: h.text }] })),
      { role: "user", parts: [{ text: prompt }] }
    ],
  });

  const response = await model;
  return response.text;
}
