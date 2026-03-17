import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());
  app.use(cookieParser());

  // Garmin OAuth 2.0 Endpoints
  app.get("/api/auth/garmin/url", (req, res) => {
    const clientId = process.env.GARMIN_CLIENT_ID;
    if (!clientId) {
      return res.status(500).json({ error: "GARMIN_CLIENT_ID not configured" });
    }
    
    const redirectUri = `${process.env.APP_URL}/api/auth/garmin/callback`;
    const scope = "activity:read health:read"; // Garmin scopes
    
    // Garmin OAuth 2.0 Authorize URL
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scope,
    });
    
    const authUrl = `https://connect.garmin.com/oauthConfirm?${params.toString()}`;
    res.json({ url: authUrl });
  });

  app.get("/api/auth/garmin/callback", async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send("No code provided");

    try {
      // Exchange code for access token
      const tokenResponse = await axios.post("https://connect.garmin.com/oauth/token", new URLSearchParams({
        grant_type: "authorization_code",
        code: code as string,
        client_id: process.env.GARMIN_CLIENT_ID!,
        client_secret: process.env.GARMIN_CLIENT_SECRET!,
        redirect_uri: `${process.env.APP_URL}/api/auth/garmin/callback`,
      }).toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });

      const { access_token, refresh_token } = tokenResponse.data;
      
      // In a real app, you'd store these tokens in Firestore linked to the user
      // For the popup to communicate back, we use postMessage
      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ 
                  type: 'GARMIN_AUTH_SUCCESS',
                  accessToken: '${access_token}',
                  refreshToken: '${refresh_token}'
                }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Authentication successful! Syncing your data...</p>
          </body>
        </html>
      `);
    } catch (error: any) {
      console.error("Garmin Token Exchange Error:", error.response?.data || error.message);
      res.status(500).send("Failed to exchange Garmin token");
    }
  });

  // Real Garmin Data Fetching
  app.get("/api/garmin/activities", async (req, res) => {
    const accessToken = req.headers.authorization?.split(" ")[1];
    if (!accessToken) return res.status(401).json({ error: "No access token" });

    try {
      // Fetch activities from Garmin Connect API
      const response = await axios.get("https://connect.garmin.com/modern/proxy/activitylist-service/activities/search/activities", {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { limit: 100 }
      });
      
      res.json(response.data);
    } catch (error: any) {
      console.error("Garmin Fetch Error:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to fetch Garmin activities" });
    }
  });

  app.post("/api/garmin/sync-manual", async (req, res) => {
    const { token, uid } = req.body;
    if (!token) return res.status(400).json({ error: "No token provided" });
    
    const headers = { 
      'Authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}`,
      'Cookie': token.includes('=') ? token : ''
    };

    try {
      // 1. Fetch Activities
      const activitiesRes = await axios.get("https://connect.garmin.com/modern/proxy/activitylist-service/activities/search/activities", {
        headers,
        params: { limit: 50 }
      });

      // 2. Fetch Health Metrics (HRV, RHR, Sleep)
      // Note: These endpoints might vary based on the type of token/session
      let healthData = { hrv: [], rhr: [], sleep: [] };
      try {
        const today = new Date().toISOString().split('T')[0];
        const hrvRes = await axios.get(`https://connect.garmin.com/modern/proxy/hrv-service/hrv/${today}`, { headers });
        healthData.hrv = hrvRes.data?.hrvSummaries || [];
      } catch (e) { console.log("HRV fetch failed, skipping..."); }

      try {
        const rhrRes = await axios.get("https://connect.garmin.com/modern/proxy/userstats-service/statistics/restingHeartRate", { headers });
        healthData.rhr = rhrRes.data || [];
      } catch (e) { console.log("RHR fetch failed, skipping..."); }
      
      res.json({ 
        success: true, 
        activities: activitiesRes.data,
        health: healthData,
        message: "Real data fetched from Garmin Connect."
      });
    } catch (error: any) {
      console.error("Manual Sync Error:", error.response?.data || error.message);
      res.status(500).json({ 
        error: "Failed to fetch data. Please ensure your Garmin session token is valid.",
        details: error.response?.data
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
