import { GarminConnect } from 'garmin-connect';
import https from 'https';

export class GarminService {
  private client: any = null;
  private httpsAgent = new https.Agent({
    rejectUnauthorized: false,
  });

  constructor() {
    this.client = new GarminConnect();
  }

  async login(username: string, password: string) {
    try {
      await this.client!.login(username, password);
      return true;
    } catch (error: any) {
      console.error("Garmin Login Error:", error.message);
      throw new Error(`Failed to login to Garmin: ${error.message}`);
    }
  }

  async getActivities(limit: number = 50) {
    if (!this.client) throw new Error("Client not initialized");
    return await this.client.getActivities(0, limit);
  }

  async getHeartRate(date: Date) {
    if (!this.client) throw new Error("Client not initialized");
    return await this.client.getHeartRate(date);
  }

  async getSleep(date: Date) {
    if (!this.client) throw new Error("Client not initialized");
    return await this.client.getSleep(date);
  }

  async getRHR() {
    // garmin-connect lib might not have all methods, fallback to raw if needed
    // but it has getActivities, getHeartRate, getSleep, getSteps
    return await this.client!.getUserStats(new Date());
  }
}
