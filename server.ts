import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import axios from "axios";
import https from "https";
// @ts-ignore
import { HttpClient } from "garmin-connect-client/dist/http-client.js";
// @ts-ignore
import { GarminUrls } from "garmin-connect-client/dist/urls.js";
// @ts-ignore
import { AuthContext } from "garmin-connect-client/dist/auth-context.js";

dotenv.config();

// Create an https agent that ignores SSL certificate errors
// This is often needed in environments with strict network proxies or missing CA certs
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

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
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        httpsAgent
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
        params: { limit: 100 },
        httpsAgent
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
    
    // Improve header construction
    let authHeader = '';
    let cookieHeader = '';

    if (token.includes('=')) {
      // Likely a full cookie string
      cookieHeader = token;
    } else if (token.startsWith('eyJ')) {
      // Likely a JWT
      authHeader = `Bearer ${token}`;
    } else {
      // Treat as a raw SESSIONID (hash)
      cookieHeader = `SESSIONID=${token}`;
    }

    const headers = { 
      'Authorization': authHeader,
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://connect.garmin.com/modern/activities'
    };

    try {
      console.log(`Attempting manual sync for UID: ${uid}`);
      // 1. Fetch Activities
      const activitiesRes = await axios.get("https://connect.garmin.com/modern/proxy/activitylist-service/activities/search/activities", {
        headers,
        params: { limit: 50 },
        httpsAgent
      });

      // Check if we got HTML instead of JSON (Garmin redirects to login page on session expiry)
      if (typeof activitiesRes.data === 'string' && activitiesRes.data.includes('<!DOCTYPE html>')) {
        console.error("Garmin session expired: Received HTML login page instead of JSON data.");
        return res.status(401).json({ 
          error: "Garmin session expired.",
          hint: "Your Garmin session token or cookie has expired. Please log in to connect.garmin.com again and copy a fresh SESSIONID or JWT."
        });
      }

      console.log(`Fetched ${activitiesRes.data?.length || 0} activities from Garmin.`);
      if (activitiesRes.data && activitiesRes.data.length > 0) {
        console.log("Sample Activity ID:", activitiesRes.data[0].activityId);
      }

      // 2. Fetch Health Metrics (HRV, RHR, Sleep)
      let healthData = { hrv: [], rhr: [], sleep: [] };
      try {
        const today = new Date().toISOString().split('T')[0];
        const hrvRes = await axios.get(`https://connect.garmin.com/modern/proxy/hrv-service/hrv/${today}`, { 
          headers,
          httpsAgent
        });
        healthData.hrv = hrvRes.data?.hrvSummaries || [];
        console.log(`Fetched ${healthData.hrv.length} HRV summaries.`);
      } catch (e: any) { 
        console.log("HRV fetch failed:", e.message); 
      }

      try {
        const rhrRes = await axios.get("https://connect.garmin.com/modern/proxy/userstats-service/statistics/restingHeartRate", { 
          headers,
          httpsAgent
        });
        healthData.rhr = rhrRes.data || [];
        console.log(`Fetched ${healthData.rhr.length} RHR records.`);
      } catch (e: any) { 
        console.log("RHR fetch failed:", e.message); 
      }
      
      res.json({ 
        success: true, 
        activities: activitiesRes.data,
        health: healthData,
        message: "Real data fetched from Garmin Connect."
      });
    } catch (error: any) {
      const statusCode = error.response?.status || 500;
      const errorData = error.response?.data;
      console.error("Manual Sync Error:", {
        status: statusCode,
        message: error.message,
        data: errorData
      });
      
      res.status(statusCode).json({ 
        error: "Failed to fetch data from Garmin.",
        message: error.message,
        details: errorData,
        hint: "Please ensure your Garmin session token/cookie is valid and not expired. You may need to refresh your login on connect.garmin.com."
      });
    }
  });

  app.post("/api/garmin/sync-garth", async (req, res) => {
    const { session, uid } = req.body;
    if (!session) return res.status(400).json({ error: "No session provided" });

    try {
      console.log(`Attempting Garth sync for UID: ${uid}`);
      
      const urls = new GarminUrls();
      const authContext = new AuthContext(
        false, 
        session.cookies, 
        undefined, 
        undefined, 
        session.oauth1Token, 
        session.oauth2Token
      );
      const client = new HttpClient(urls, authContext);

      // 1. Fetch Activities
      const activities = await client.get(urls.ACTIVITY_SEARCH(0, 50));
      console.log(`Garth: Fetched ${Array.isArray(activities) ? activities.length : 0} activities.`);

      // 2. Fetch Health Metrics
      let healthData = { hrv: [], rhr: [], sleep: [] };
      try {
        const today = new Date().toISOString().split('T')[0];
        const hrvRes: any = await client.get(`https://connect.garmin.com/modern/proxy/hrv-service/hrv/${today}`);
        healthData.hrv = hrvRes?.hrvSummaries || [];
      } catch (e: any) { console.log("Garth HRV fetch failed:", e.message); }

      try {
        const rhrRes: any = await client.get("https://connect.garmin.com/modern/proxy/userstats-service/statistics/restingHeartRate");
        healthData.rhr = rhrRes || [];
      } catch (e: any) { console.log("Garth RHR fetch failed:", e.message); }

      res.json({ 
        success: true, 
        activities,
        health: healthData,
        message: "Real data fetched using Garth session."
      });
    } catch (error: any) {
      console.error("Garth Sync Error:", error.message);
      res.status(500).json({ 
        error: "Failed to fetch data using Garth session.",
        message: error.message
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
