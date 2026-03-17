import React, { useState, useEffect, useRef, useMemo } from "react";
import { 
  auth, 
  db 
} from "./firebase";
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  User 
} from "firebase/auth";
import { 
  doc, 
  getDoc, 
  setDoc, 
  collection, 
  query, 
  orderBy, 
  limit, 
  onSnapshot,
  writeBatch
} from "firebase/firestore";
import { 
  Activity, 
  HealthMetric, 
  UserProfile, 
  ChatMessage 
} from "./types";
import { getCoachResponse } from "./services/gemini";
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  BarChart, 
  Bar 
} from "recharts";
import { 
  Activity as ActivityIcon, 
  Heart, 
  Zap,
  MessageSquare, 
  Settings, 
  LogOut, 
  ChevronRight, 
  TrendingUp,
  Clock,
  MapPin
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import ReactMarkdown from "react-markdown";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [healthMetrics, setHealthMetrics] = useState<HealthMetric[]>([]);
  const [garminToken, setGarminToken] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [selectedMetric, setSelectedMetric] = useState<"pace" | "eph">("pace");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [activeTab, setActiveTab] = useState<"dashboard" | "activities">("dashboard");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const weeklyVolumeData = useMemo(() => {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    return days.map((day, index) => {
      const date = new Date(startOfWeek);
      date.setDate(startOfWeek.getDate() + index);
      const dateStr = date.toISOString().split('T')[0];
      
      const dayActivities = activities.filter(a => a.startTime.startsWith(dateStr));
      const totalKm = dayActivities.reduce((sum, a) => sum + a.distance, 0);
      
      return { day, km: parseFloat(totalKm.toFixed(1)) };
    });
  }, [activities]);

  const hrvTrendData = useMemo(() => {
    if (healthMetrics.length === 0) return mockChartData.map(d => ({ day: d.day, hrv: 0 }));
    return [...healthMetrics]
      .slice(0, 7)
      .reverse()
      .map(m => ({
        day: new Date(m.date).toLocaleDateString(undefined, { weekday: 'short' }),
        hrv: m.hrv || 0
      }));
  }, [healthMetrics]);

  const stats = useMemo(() => {
    const weeklyDist = weeklyVolumeData.reduce((sum, d) => sum + d.km, 0).toFixed(1);
    const avgHRV = healthMetrics.length > 0 
      ? Math.round(healthMetrics.reduce((sum, m) => sum + (m.hrv || 0), 0) / healthMetrics.length) 
      : "--";
    const latestVO2 = activities.find(a => a.vo2Max)?.vo2Max || "--";
    
    return {
      weeklyDist,
      avgHRV,
      latestVO2
    };
  }, [weeklyVolumeData, healthMetrics, profile, activities]);

  useEffect(() => {
    console.log(`Activities state updated: ${activities.length} items`);
  }, [activities]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        fetchProfile(u.uid);
        subscribeToData(u.uid);
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  const handleFirestoreError = (error: any, operation: any, path: string | null) => {
    const errInfo = {
      error: error.message || String(error),
      operationType: operation,
      path: path,
      authInfo: {
        userId: auth.currentUser?.uid,
        email: auth.currentUser?.email,
        emailVerified: auth.currentUser?.emailVerified,
        isAnonymous: auth.currentUser?.isAnonymous,
        providerInfo: auth.currentUser?.providerData.map(p => ({
          providerId: p.providerId,
          displayName: p.displayName,
          email: p.email
        })) || []
      }
    };
    console.error('Firestore Error Details:', JSON.stringify(errInfo, null, 2));
    throw error;
  };

  const fetchProfile = async (uid: string) => {
    const docRef = doc(db, "users", uid);
    try {
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const data = docSnap.data() as UserProfile;
        setProfile(data);
        if (data.garminToken) {
          setGarminToken(data.garminToken);
          // Auto-sync on load if token exists
          setTimeout(() => {
            const syncBtn = document.getElementById('manual-sync-btn');
            if (syncBtn && !isTyping) syncBtn.click();
          }, 1000);
        }
      } else {
        const newProfile: UserProfile = {
          uid,
          displayName: auth.currentUser?.displayName || "",
          email: auth.currentUser?.email || "",
          garminConnected: false,
        };
        await setDoc(docRef, newProfile);
        setProfile(newProfile);
      }
    } catch (err) {
      handleFirestoreError(err, "get", `users/${uid}`);
    }
  };

  const subscribeToData = (uid: string) => {
    const activitiesQuery = query(
      collection(db, "users", uid, "activities"),
      orderBy("startTime", "desc"),
      limit(50)
    );
    onSnapshot(activitiesQuery, (snapshot) => {
      setActivities(snapshot.docs.map(d => d.data() as Activity));
    }, (err) => handleFirestoreError(err, "list", `users/${uid}/activities`));

    const healthQuery = query(
      collection(db, "users", uid, "health_metrics"),
      orderBy("date", "desc"),
      limit(14)
    );
    onSnapshot(healthQuery, (snapshot) => {
      setHealthMetrics(snapshot.docs.map(d => d.data() as HealthMetric));
    }, (err) => handleFirestoreError(err, "list", `users/${uid}/health_metrics`));
  };

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isTyping) return;

    const userMessage: ChatMessage = { role: "user", text: input };
    setChatHistory(prev => [...prev, userMessage]);
    setInput("");
    setIsTyping(true);

    try {
      const response = await getCoachResponse(
        input, 
        activities, 
        healthMetrics, 
        chatHistory, 
        profile?.summary30d,
        profile?.coachInsights
      );
      
      let cleanResponse = response || "Sorry, I couldn't process that.";
      
      // Check for new insights to store
      if (cleanResponse.includes("NEW_INSIGHT:")) {
        const parts = cleanResponse.split("NEW_INSIGHT:");
        cleanResponse = parts[0].trim();
        const newInsight = parts[1].trim();
        
        if (user && profile) {
          const updatedProfile = { ...profile, coachInsights: newInsight };
          await setDoc(doc(db, "users", user.uid), updatedProfile, { merge: true });
          setProfile(updatedProfile);
        }
      }

      setChatHistory(prev => [...prev, { role: "model", text: cleanResponse }]);
    } catch (err) {
      console.error("Gemini error", err);
      setChatHistory(prev => [...prev, { role: "model", text: "I'm having trouble connecting to my brain right now. Please try again." }]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleManualSync = async () => {
    if (!garminToken || !user) return;
    setIsTyping(true);
    setChatHistory(prev => [...prev, { role: "model", text: "Connecting to Garmin using your personal token..." }]);
    
    try {
      let isGarth = false;
      let garthSession = null;
      
      try {
        const parsed = JSON.parse(garminToken);
        if (parsed.cookies && parsed.oauth1Token && parsed.oauth2Token) {
          isGarth = true;
          garthSession = parsed;
        }
      } catch (e) {
        // Not a JSON/Garth session, treat as raw token
      }

      const endpoint = isGarth ? "/api/garmin/sync-garth" : "/api/garmin/sync-manual";
      const payload = isGarth ? { session: garthSession, uid: user.uid } : { token: garminToken, uid: user.uid };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      
      const data = await res.json();
      console.log("Garmin API Response Data:", data);

      if (!res.ok) {
        throw new Error(data.error || "Garmin API rejected the token. Please check if your session is still active.");
      }
      
      const garminActivities = data.activities;
      if (!garminActivities || garminActivities.length === 0) {
        console.warn("No activities returned from Garmin.");
        setChatHistory(prev => [...prev, { role: "model", text: "The token is valid, but Garmin returned 0 activities for the last 30 days. Please check your Garmin Connect account." }]);
        setIsTyping(false);
        return;
      }

      console.log(`Processing ${garminActivities.length} activities...`);
      const batch = writeBatch(db);
      const syncedActivities: Activity[] = [];

      for (const gAct of garminActivities) {
        if (!gAct.activityId || !gAct.startTimeLocal) continue;

        const distanceKm = Number((gAct.distance / 1000).toFixed(2));
        const paceValue = distanceKm > 0 ? Number((gAct.duration / 60 / distanceKm).toFixed(2)) : 0;

        // Map Garmin labels to our internal types
        let te: "Threshold" | "Marathon" | "Tempo" | "Recovery" | "Easy" = "Easy";
        const label = gAct.trainingEffectLabel?.toUpperCase();
        if (label === 'THRESHOLD' || gAct.aerobicTrainingEffect > 4) te = "Threshold";
        else if (label === 'TEMPO' || gAct.aerobicTrainingEffect > 3.5) te = "Tempo";
        else if (label === 'BASE' || label === 'AEROBIC_BASE' || gAct.aerobicTrainingEffect > 2.5) te = "Marathon";
        else if (label === 'RECOVERY' || gAct.aerobicTrainingEffect < 2) te = "Recovery";

        const activityData: Activity = {
          uid: user.uid,
          activityId: String(gAct.activityId),
          activityName: gAct.activityName || "Running",
          type: gAct.activityType?.typeKey === 'trail_running' ? "TRAIL_RUNNING" : "RUNNING",
          startTime: gAct.startTimeLocal,
          distance: distanceKm,
          duration: gAct.duration,
          pace: paceValue,
          trainingEffect: te,
          averageHeartRate: gAct.averageHR || 0,
          eph: gAct.vO2MaxValue ? (gAct.vO2MaxValue * 2) : 70,
          vo2Max: gAct.vO2MaxValue || 0
        };
        
        const activityRef = doc(db, "users", user.uid, "activities", activityData.activityId);
        batch.set(activityRef, activityData, { merge: true });
        syncedActivities.push(activityData);
      }
      
      try {
        await batch.commit();
        console.log("Activities batch committed successfully.");
      } catch (err) {
        handleFirestoreError(err, "write", `users/${user.uid}/activities`);
      }

      // Process Health Metrics
      let latestHRV = 0;
      if (data.health) {
        const healthBatch = writeBatch(db);
        const hrvData = Array.isArray(data.health.hrv) ? data.health.hrv : [];
        const rhrData = Array.isArray(data.health.rhr) ? data.health.rhr : [];
        
        rhrData.forEach((r: any) => {
          const date = r.calendarDate;
          if (!date) return;
          const hrvVal = hrvData.find((h: any) => h.calendarDate === date)?.lastNightAvg || 0;
          if (hrvVal > 0) latestHRV = hrvVal;

          const metric: HealthMetric = {
            uid: user.uid,
            date,
            restingHeartRate: r.restingHeartRate,
            hrv: hrvVal
          };
          const ref = doc(db, "users", user.uid, "health_metrics", date);
          healthBatch.set(ref, metric, { merge: true });
        });
        try {
          await healthBatch.commit();
        } catch (err) {
          handleFirestoreError(err, "write", `users/${user.uid}/health_metrics`);
        }
      }

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const last30Days = syncedActivities.filter(a => new Date(a.startTime) > thirtyDaysAgo);
      
      const summary = {
        totalDistance: Number(last30Days.reduce((sum, a) => sum + a.distance, 0).toFixed(1)),
        avgPace: Number((last30Days.reduce((sum, a) => sum + a.pace, 0) / (last30Days.length || 1)).toFixed(2)),
        activityCount: last30Days.length,
        lastUpdated: new Date().toISOString(),
        paceByEffect: {} as any,
        hrByEffect: {} as any,
        avgHRV: latestHRV || profile?.summary30d?.avgHRV || 0
      };

      const effects: ("Threshold" | "Marathon" | "Tempo" | "Recovery" | "Easy")[] = ["Threshold", "Marathon", "Tempo", "Recovery", "Easy"];
      effects.forEach(effect => {
        const effectActivities = last30Days.filter(a => a.trainingEffect === effect);
        if (effectActivities.length > 0) {
          summary.paceByEffect[effect] = Number((effectActivities.reduce((sum, a) => sum + a.pace, 0) / effectActivities.length).toFixed(2));
          summary.hrByEffect[effect] = Math.round(effectActivities.reduce((sum, a) => sum + (a.averageHeartRate || 0), 0) / effectActivities.length);
        }
      });

      const updatedProfile = { 
        ...profile, 
        lastSync: new Date().toISOString(),
        garminConnected: true,
        garminToken: garminToken,
        summary30d: { ...profile?.summary30d, ...summary }
      };
      
      try {
        await setDoc(doc(db, "users", user.uid), updatedProfile, { merge: true });
      } catch (err) {
        handleFirestoreError(err, "update", `users/${user.uid}`);
      }
      setProfile(updatedProfile as UserProfile);
      
      setChatHistory(prev => [...prev, { role: "model", text: "Success! I've fetched your activities from the last 30 days from Garmin using your token. Your dashboard is now updated." }]);
      setShowSettings(false);
    } catch (err: any) {
      console.error("Sync error:", err);
      setChatHistory(prev => [...prev, { role: "model", text: `Error: ${err.message || "Failed to sync data."}` }]);
    } finally {
      setIsTyping(false);
    }
  };

  const performanceData = activities
    .slice()
    .reverse()
    .filter(activity => {
      if (selectedMetric === 'eph') {
        return activity.type === 'TRAIL_RUNNING';
      }
      return true;
    })
    .map(activity => {
      const date = new Date(activity.startTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const eph = activity.eph || 0;
      
      return {
        date,
        eph: parseFloat(eph.toFixed(1)),
        [`pace_${activity.trainingEffect || 'Easy'}`]: activity.pace,
        pace: activity.pace,
        category: activity.trainingEffect || 'Easy'
      };
    });

  if (!user) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full text-center space-y-8"
        >
          <div className="flex justify-center">
            <div className="w-20 h-20 bg-emerald-500 rounded-3xl flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <ActivityIcon size={40} className="text-black" />
            </div>
          </div>
          <div className="space-y-2">
            <h1 className="text-4xl font-bold tracking-tight">G-Coach</h1>
            <p className="text-zinc-400">Your AI-powered Garmin running coach.</p>
          </div>
          <button 
            onClick={handleLogin}
            className="w-full py-4 bg-white text-black font-semibold rounded-2xl hover:bg-zinc-200 transition-colors flex items-center justify-center gap-3"
          >
            <img src="https://www.google.com/favicon.ico" className="w-5 h-5" alt="Google" />
            Continue with Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Main Content */}
      <main className="flex flex-col min-h-screen">
        <header className="h-14 sm:h-16 border-b border-white/5 flex items-center justify-between px-4 sm:px-6 shrink-0 sticky top-0 bg-[#0a0a0a]/80 backdrop-blur-md z-50">
          <div className="flex items-center gap-6 sm:gap-8">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 sm:w-8 sm:h-8 bg-emerald-500 rounded-lg flex items-center justify-center">
                <ActivityIcon className="text-black w-3.5 h-3.5 sm:w-4 sm:h-4" />
              </div>
              <h2 className="font-semibold text-base sm:text-lg">G-Coach</h2>
            </div>

            <nav className="hidden md:flex items-center gap-1">
              <button 
                onClick={() => setActiveTab("dashboard")}
                className={`px-4 py-2 text-sm font-medium rounded-xl transition-colors ${activeTab === 'dashboard' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                Dashboard
              </button>
              <button 
                onClick={() => setActiveTab("activities")}
                className={`px-4 py-2 text-sm font-medium rounded-xl transition-colors ${activeTab === 'activities' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                Activities
              </button>
            </nav>
          </div>
          
          <div className="flex items-center gap-2 sm:gap-4">
            {!profile?.garminConnected ? (
              <div className="hidden sm:flex items-center gap-2 text-zinc-500 text-[10px]">
                <div className="w-1 h-1 bg-zinc-500 rounded-full" />
                Offline
              </div>
            ) : (
              <div className="hidden sm:flex flex-col items-end">
                <div className="flex items-center gap-1.5 text-emerald-500 text-[9px] font-medium">
                  <div className="w-1 h-1 bg-emerald-500 rounded-full animate-pulse" />
                  Connected
                </div>
              </div>
            )}

            <div className="h-6 w-px bg-white/5 mx-1 sm:mx-2" />

            <button 
              onClick={() => setShowSettings(!showSettings)}
              className="p-1.5 sm:p-2 text-zinc-400 hover:text-white transition-colors"
            >
              <Settings className="w-4.5 h-4.5 sm:w-5 sm:h-5" />
            </button>

            <div className="flex items-center gap-2 sm:gap-3 pl-1 sm:pl-2 border-l border-white/5">
              <img src={user.photoURL || ""} className="w-7 h-7 sm:w-8 sm:h-8 rounded-full border border-white/10" alt="User" />
              <button onClick={() => auth.signOut()} className="text-zinc-500 hover:text-white transition-colors">
                <LogOut className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
              </button>
            </div>
          </div>
        </header>

        <div className="flex-1 p-4 sm:p-6 space-y-4 sm:space-y-6 max-w-7xl mx-auto w-full">
          {/* Mobile Nav */}
          <div className="md:hidden flex bg-zinc-900/50 p-1 rounded-2xl border border-white/5">
            <button 
              onClick={() => setActiveTab("dashboard")}
              className={`flex-1 py-2 text-xs font-medium rounded-xl transition-colors ${activeTab === 'dashboard' ? 'bg-emerald-500 text-black' : 'text-zinc-500'}`}
            >
              Dashboard
            </button>
            <button 
              onClick={() => setActiveTab("activities")}
              className={`flex-1 py-2 text-xs font-medium rounded-xl transition-colors ${activeTab === 'activities' ? 'bg-emerald-500 text-black' : 'text-zinc-500'}`}
            >
              Activities
            </button>
          </div>

          {/* Settings / Token Input Overlay */}
          <AnimatePresence>
            {showSettings && (
              <motion.div 
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="bg-zinc-900 border border-emerald-500/20 rounded-2xl p-6 mb-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-emerald-500">Garmin Personal Token Setup</h3>
                    <button onClick={() => setShowSettings(false)} className="text-zinc-500 hover:text-white">
                      <ChevronRight className="rotate-90" size={20} />
                    </button>
                  </div>
                  <p className="text-sm text-zinc-400">
                    {profile?.garminToken 
                      ? "Your Garmin account is bound. You can update your token below if it has expired." 
                      : "Enter your personal Garmin access token (JWT or Session) to bind your account."}
                  </p>
                  
                  <div className="bg-black/40 p-3 rounded-xl border border-white/5 space-y-2">
                    <p className="text-[10px] font-bold text-emerald-500 uppercase tracking-wider">How to get your Garth session:</p>
                    <div className="space-y-1">
                      <ol className="text-[9px] text-zinc-500 list-decimal list-inside space-y-1">
                        <li>Use a tool like <code className="text-emerald-500">garth</code> to export your session.</li>
                        <li>Paste the full JSON string (including cookies & OAuth tokens) below.</li>
                        <li>This method provides the most stable connection and complete health data.</li>
                      </ol>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3">
                    <div className="relative">
                      <input 
                        type="password"
                        value={garminToken}
                        onChange={(e) => setGarminToken(e.target.value)}
                        placeholder="Paste your Garmin token here..."
                        className="w-full bg-black border border-white/10 rounded-xl px-4 py-2 focus:border-emerald-500 outline-none text-sm"
                      />
                      {profile?.garminToken && (
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1 text-[10px] text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                          <div className="w-1 h-1 bg-emerald-500 rounded-full" />
                          Bound
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button 
                        id="manual-sync-btn"
                        onClick={handleManualSync}
                        disabled={!garminToken || isTyping}
                        className="flex-1 py-3 bg-emerald-500 text-black font-bold rounded-xl hover:bg-emerald-400 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        <ActivityIcon size={20} />
                        {profile?.garminToken ? "Update & Sync" : "Bind & Sync"}
                      </button>
                      {profile?.garminToken && (
                        <button 
                          onClick={async () => {
                            if (!user || !profile) return;
                            const { garminToken: _, ...rest } = profile;
                            const updated = { ...rest, garminConnected: false };
                            await setDoc(doc(db, "users", user.uid), updated);
                            setProfile(updated as UserProfile);
                            setGarminToken("");
                          }}
                          className="px-4 bg-zinc-800 text-zinc-400 rounded-xl hover:text-rose-500 transition-colors"
                          title="Unbind Token"
                        >
                          <LogOut size={18} />
                        </button>
                      )}
                    </div>
                    {profile?.lastSync && (
                      <p className="text-[10px] text-zinc-500 text-center">
                        Last synced: {new Date(profile.lastSync).toLocaleString()}
                      </p>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {activeTab === "dashboard" ? (
            <>
              {/* Stats Grid */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                <StatCard 
                  label="Weekly Dist" 
                  value={`${stats.weeklyDist} km`} 
                  trend={activities.length > 0 ? "Active" : "No Data"} 
                  icon={<MapPin size={18} className="text-emerald-500" />} 
                />
                <StatCard 
                  label="Avg. HRV" 
                  value={stats.avgHRV === "--" ? "--" : `${stats.avgHRV} ms`} 
                  trend={healthMetrics.length > 0 ? "Synced" : "No Data"} 
                  icon={<Heart size={18} className="text-rose-500" />} 
                />
                <StatCard 
                  label="VO2 Max" 
                  value={String(stats.latestVO2)} 
                  trend="Garmin" 
                  icon={<Zap size={18} className="text-amber-500" />} 
                />
                <StatCard 
                  label="Load" 
                  value={profile?.summary30d ? "Optimal" : "--"} 
                  trend={profile?.summary30d ? "Good" : "No Data"} 
                  icon={<Clock size={18} className="text-blue-500" />} 
                />
              </div>

              {/* Charts */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
                <div className="bg-zinc-900/50 border border-white/5 rounded-2xl p-4 sm:p-6">
                  <h3 className="text-sm font-medium mb-4 sm:mb-6">Weekly Volume (km)</h3>
                  <div className="h-[200px] sm:h-[250px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={weeklyVolumeData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                        <XAxis dataKey="day" stroke="#666" fontSize={12} />
                        <YAxis stroke="#666" fontSize={12} />
                        <Tooltip 
                          contentStyle={{ backgroundColor: '#18181b', border: '1px solid #333', borderRadius: '8px' }}
                          itemStyle={{ color: '#10b981' }}
                        />
                        <Bar dataKey="km" fill="#10b981" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="bg-zinc-900/50 border border-white/5 rounded-2xl p-4 sm:p-6">
                  <h3 className="text-sm font-medium mb-4 sm:mb-6">HRV Status</h3>
                  <div className="h-[200px] sm:h-[250px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={hrvTrendData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                        <XAxis dataKey="day" stroke="#666" fontSize={12} />
                        <YAxis stroke="#666" fontSize={12} />
                        <Tooltip 
                          contentStyle={{ backgroundColor: '#18181b', border: '1px solid #333', borderRadius: '8px' }}
                        />
                        <Line type="monotone" dataKey="hrv" stroke="#f43f5e" strokeWidth={2} dot={{ r: 4 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              {/* Performance Trends Chart */}
              <div className="bg-zinc-900/50 border border-white/5 rounded-2xl p-4 sm:p-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 sm:mb-8">
                  <div>
                    <h3 className="text-sm font-medium">Performance Trends</h3>
                    <p className="text-[10px] text-zinc-500">
                      {selectedMetric === 'pace' ? 'Pace trends by training effect' : 'EPH trend (Trail Running)'}
                    </p>
                  </div>
                  <div className="flex bg-black/40 p-1 rounded-xl border border-white/5 self-start sm:self-auto">
                    <button 
                      onClick={() => setSelectedMetric("pace")}
                      className={`px-3 sm:px-4 py-1 text-[10px] sm:text-xs font-medium rounded-lg transition-colors ${selectedMetric === 'pace' ? 'bg-emerald-500 text-black' : 'text-zinc-400 hover:text-white'}`}
                    >
                      Pace
                    </button>
                    <button 
                      onClick={() => setSelectedMetric("eph")}
                      className={`px-3 sm:px-4 py-1 text-[10px] sm:text-xs font-medium rounded-lg transition-colors ${selectedMetric === 'eph' ? 'bg-emerald-500 text-black' : 'text-zinc-400 hover:text-white'}`}
                    >
                      EPH
                    </button>
                  </div>
                </div>
                
                <div className="h-[250px] sm:h-[350px]">
                  {performanceData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={performanceData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                        <XAxis dataKey="date" stroke="#666" fontSize={12} tickMargin={10} />
                        <YAxis 
                          stroke="#666" 
                          fontSize={12} 
                          domain={['auto', 'auto']}
                          reversed={selectedMetric === 'pace'} 
                          label={{ 
                            value: selectedMetric === 'pace' ? 'Pace (min/km)' : 'EPH (Effort Points/hr)', 
                            angle: -90, 
                            position: 'insideLeft',
                            style: { fill: '#666', fontSize: 10 }
                          }}
                        />
                        <Tooltip 
                          contentStyle={{ backgroundColor: '#18181b', border: '1px solid #333', borderRadius: '8px' }}
                          labelStyle={{ color: '#999', marginBottom: '4px' }}
                          formatter={(value: any, name: string) => {
                            if (name.startsWith('pace_')) {
                              return [`${value} min/km`, name.replace('pace_', '')];
                            }
                            return [value, name.toUpperCase()];
                          }}
                        />
                        {selectedMetric === 'pace' ? (
                          <>
                            <Line type="monotone" dataKey="pace_Threshold" name="Threshold" stroke="#ef4444" strokeWidth={2} connectNulls dot={{ r: 4 }} />
                            <Line type="monotone" dataKey="pace_Marathon" name="Marathon" stroke="#f59e0b" strokeWidth={2} connectNulls dot={{ r: 4 }} />
                            <Line type="monotone" dataKey="pace_Tempo" name="Tempo" stroke="#10b981" strokeWidth={2} connectNulls dot={{ r: 4 }} />
                            <Line type="monotone" dataKey="pace_Recovery" name="Recovery" stroke="#3b82f6" strokeWidth={2} connectNulls dot={{ r: 4 }} />
                            <Line type="monotone" dataKey="pace_Easy" name="Easy" stroke="#8b5cf6" strokeWidth={2} connectNulls dot={{ r: 4 }} />
                          </>
                        ) : (
                          <Line 
                            type="monotone" 
                            dataKey="eph" 
                            name="EPH"
                            stroke="#10b981" 
                            strokeWidth={3} 
                            dot={{ r: 4, fill: '#10b981', strokeWidth: 2, stroke: '#000' }}
                            activeDot={{ r: 6, strokeWidth: 0 }}
                          />
                        )}
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-zinc-500 space-y-2">
                      <ActivityIcon size={32} className="opacity-20" />
                      <p className="text-sm">No activity data available yet.</p>
                    </div>
                  )}
                </div>
                {selectedMetric === 'pace' && (
                  <div className="mt-4 flex flex-wrap justify-center gap-4">
                    <LegendItem color="#ef4444" label="Threshold" />
                    <LegendItem color="#f59e0b" label="Marathon" />
                    <LegendItem color="#10b981" label="Tempo" />
                    <LegendItem color="#3b82f6" label="Recovery" />
                    <LegendItem color="#8b5cf6" label="Easy" />
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold">Recent Activities</h3>
                <span className="text-xs text-zinc-500">Showing last 10 activities</span>
              </div>
              <div className="grid grid-cols-1 gap-3">
                {activities.slice(0, 10).map((activity) => (
                  <motion.div 
                    key={activity.activityId}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="bg-zinc-900/50 border border-white/5 rounded-2xl p-4 flex items-center justify-between hover:border-emerald-500/30 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className={`p-3 rounded-xl ${
                        activity.type === 'TRAIL_RUNNING' ? 'bg-amber-500/10 text-amber-500' : 'bg-emerald-500/10 text-emerald-500'
                      }`}>
                        <ActivityIcon size={20} />
                      </div>
                      <div>
                        <h4 className="font-bold text-sm">{activity.activityName || "Running"}</h4>
                        <div className="flex items-center gap-3 text-[10px] text-zinc-500 mt-1">
                          <span className="flex items-center gap-1"><Clock size={10} /> {new Date(activity.startTime).toLocaleString()}</span>
                          <span className="flex items-center gap-1"><MapPin size={10} /> {activity.distance} km</span>
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold">{activity.pace} <span className="text-[10px] font-normal text-zinc-500">min/km</span></div>
                      <div className={`text-[10px] mt-1 px-2 py-0.5 rounded-full inline-block ${
                        activity.trainingEffect === 'Threshold' ? 'bg-rose-500/10 text-rose-500' :
                        activity.trainingEffect === 'Tempo' ? 'bg-emerald-500/10 text-emerald-500' :
                        'bg-zinc-500/10 text-zinc-500'
                      }`}>
                        {activity.trainingEffect}
                      </div>
                    </div>
                  </motion.div>
                ))}
                {activities.length === 0 && (
                  <div className="py-20 text-center text-zinc-500 space-y-2">
                    <ActivityIcon size={40} className="mx-auto opacity-20" />
                    <p>No activities found. Please sync your Garmin account.</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Chat Interface */}
          <div className="bg-zinc-900/50 border border-white/5 rounded-2xl flex flex-col h-[400px] sm:h-[500px]">
            <div className="p-3 sm:p-4 border-b border-white/5 flex items-center gap-2">
              <MessageSquare size={16} className="text-emerald-500" />
              <h3 className="text-sm font-medium">Coach Chat</h3>
            </div>
            
            <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3 sm:space-y-4">
              {chatHistory.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-center space-y-2 opacity-50">
                  <MessageSquare size={40} />
                  <p>Ask me about your training, race predictions, or recovery.</p>
                </div>
              )}
              <AnimatePresence initial={false}>
                {chatHistory.map((msg, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div className={`max-w-[80%] p-3 rounded-2xl ${
                      msg.role === 'user' 
                        ? 'bg-emerald-500 text-black font-medium' 
                        : 'bg-zinc-800 text-zinc-200'
                    }`}>
                      <div className="prose prose-invert prose-sm max-w-none">
                        <ReactMarkdown>
                          {msg.text}
                        </ReactMarkdown>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
              {isTyping && (
                <div className="flex justify-start">
                  <div className="bg-zinc-800 p-3 rounded-2xl flex gap-1">
                    <div className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce" />
                    <div className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce [animation-delay:0.2s]" />
                    <div className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce [animation-delay:0.4s]" />
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <form onSubmit={handleSendMessage} className="p-4 border-t border-white/5 flex gap-2">
              <input 
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask G-Coach..."
                className="flex-1 bg-zinc-800 border-none rounded-xl px-4 py-2 focus:ring-2 focus:ring-emerald-500 outline-none"
              />
              <button 
                type="submit"
                disabled={isTyping}
                className="p-2 bg-emerald-500 text-black rounded-xl hover:bg-emerald-400 disabled:opacity-50"
              >
                <ChevronRight size={20} />
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}

function StatCard({ label, value, trend, icon }: { label: string, value: string, trend: string, icon: React.ReactNode }) {
  return (
    <div className="bg-zinc-900/50 border border-white/5 rounded-2xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="p-2 bg-white/5 rounded-lg">{icon}</div>
        <span className={`text-xs font-bold px-2 py-1 rounded-full ${
          trend.startsWith('+') ? 'bg-emerald-500/10 text-emerald-500' : 
          trend.startsWith('-') ? 'bg-rose-500/10 text-rose-500' : 'bg-zinc-500/10 text-zinc-500'
        }`}>
          {trend}
        </span>
      </div>
      <div>
        <p className="text-sm text-zinc-500">{label}</p>
        <p className="text-2xl font-bold">{value}</p>
      </div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string, label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
      <span className="text-xs text-zinc-400">{label}</span>
    </div>
  );
}

const mockChartData = [
  { day: 'Mon', km: 8, hrv: 62 },
  { day: 'Tue', km: 12, hrv: 65 },
  { day: 'Wed', km: 0, hrv: 68 },
  { day: 'Thu', km: 10, hrv: 64 },
  { day: 'Fri', km: 6, hrv: 60 },
  { day: 'Sat', km: 15, hrv: 58 },
  { day: 'Sun', km: 0, hrv: 63 },
];
