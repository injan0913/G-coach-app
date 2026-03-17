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

// @ts-ignore
import { AuthenticationService } from "garmin-connect-client/dist/authentication-service.js";

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

    try {
      console.log(`Attempting manual sync for UID: ${uid} using token login (garth style)`);
      
      const urls = new GarminUrls();
      // 1. Initialize HttpClient with the SESSIONID cookie
      const httpClient = new HttpClient(urls, undefined, `SESSIONID=${token}`);
      
      // 2. Visit sign-in page to establish session (as AuthenticationService does)
      await httpClient.get(urls.SIGN_IN_PAGE(), {
        headers: {
          'User-Agent': "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
        },
      });

      // 3. Attempt to get a login ticket using the existing session
      // This mimics garth's behavior when a token is provided
      const loginUrl = urls.LOGIN_API();
      const loginBody = {
        username: "", // Not needed when session is valid
        password: "", 
        rememberMe: false,
        captchaToken: '',
      };

      let ticket;
      try {
        const loginResponse: any = await httpClient.post(loginUrl, loginBody, {
          headers: {
            'Content-Type': 'application/json',
            'Referer': urls.SIGN_IN_REFERER(),
            'User-Agent': "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
          },
        });
        ticket = loginResponse.serviceTicketId;
      } catch (e: any) {
        console.error("Failed to get ticket with SESSIONID:", e.message);
        throw new Error("Session expired or invalid. Please get a fresh SESSIONID from connect.garmin.com");
      }

      if (!ticket) {
        throw new Error("Could not obtain service ticket. SESSIONID might be invalid.");
      }

      // 4. Complete full authentication flow (Ticket -> OAuth1 -> OAuth2)
      // This is the exact same sequence garth uses
      const authenticatedClient = await AuthenticationService.completeAuthentication(urls, httpClient.getCookies(), {
        type: 'ticket',
        ticket
      });
      
      const client = authenticatedClient;

      // 6. Fetch Data
      const activities = await client.get(urls.ACTIVITY_SEARCH(0, 50));
      
      let healthData = { hrv: [], rhr: [], sleep: [] };
      try {
        const today = new Date().toISOString().split('T')[0];
        const hrvRes: any = await client.get(`https://connect.garmin.com/modern/proxy/hrv-service/hrv/${today}`);
        healthData.hrv = hrvRes?.hrvSummaries || [];
      } catch (e: any) { console.log("HRV fetch failed:", e.message); }

      try {
        const rhrRes: any = await client.get("https://connect.garmin.com/modern/proxy/userstats-service/statistics/restingHeartRate");
        healthData.rhr = rhrRes || [];
      } catch (e: any) { console.log("RHR fetch failed:", e.message); }

      res.json({ 
        success: true, 
        activities,
        health: healthData,
        session: client.getSession()
      });
    } catch (error: any) {
      console.error("Manual Sync Error:", error.message);
      res.status(500).json({ 
        error: "Failed to sync using token.",
        message: error.message
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
