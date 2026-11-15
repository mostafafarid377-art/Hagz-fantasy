import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import './translations';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
import '@fontsource-variable/noto-sans-arabic';
import './style.css';
import { DemoProvider } from './hooks/useDemo';
import { AuthProvider } from './hooks/useAuth';
import { AppModeProvider } from './hooks/useApp';
import { LiveProvider } from './hooks/useLive';
import { useAuth } from './hooks/useAuth';
import { isSupabaseConfigured } from './lib/supabase';
import AppLayout from './layouts/AppLayout';
import Dashboard from './pages/Dashboard';
import { Approvals, AuthPage, Management, Market, PlayerProfile, SuggestPlayer } from './pages/Players';
import { SquadPage } from './pages/Squad';
import { Fixtures, MatchCenter, Standings, Statistics } from './pages/Competition';
import { LeagueForm, LeagueOverview, Notifications, Profile, SettingsPage } from './pages/Other';
import { LiveAuthPage } from './pages/live/Auth';
import { LiveLeagueForm, LiveLeagueOverview } from './pages/live/League';
import { LiveApprovals, LiveManagement, LiveMarket, LivePlayerProfile, LiveSuggestPlayer } from './pages/live/Market';
import { LiveSeason, LiveSquad, LiveStandings } from './pages/live/Squad';
import { LiveFixtures, LiveMatchCenter, LiveNotifications } from './pages/live/Match';
import { DashboardRoute, ModeSwitch } from './pages/live/Routes';

// GitHub Pages cannot rewrite arbitrary paths to index.html, so its build uses
// hash routing. Other deployments keep normal browser history URLs.
const Router = import.meta.env.VITE_ROUTER_MODE === 'hash' ? HashRouter : BrowserRouter;

function LanguageDirection(){
  const {i18n}=useTranslation();
  useEffect(()=>{
    document.documentElement.lang=i18n.language;
    document.documentElement.dir=i18n.language==='ar'?'rtl':'ltr';
    localStorage.setItem('ff-language',i18n.language);
  },[i18n.language]);
  return null;
}

/**
 * The live data provider needs the signed-in user id, which only exists inside
 * AuthProvider, so it is mounted here rather than in the root render tree.
 */
function LiveData({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  if (!isSupabaseConfigured || !auth.session) return <>{children}</>;
  return <LiveProvider userId={auth.session.user.id}>{children}</LiveProvider>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <AppModeProvider>
        <DemoProvider>
          <LiveData>
            <LanguageDirection/>
            <Router basename={import.meta.env.VITE_ROUTER_MODE === 'hash' ? undefined : import.meta.env.BASE_URL}>
              <Routes>
                {/* Public / auth routes */}
                <Route path="/" element={<AuthPage type="landing"/>}/>
                <Route path="/login" element={<LiveAuthPage mode="login"/>}/>
                <Route path="/signup" element={<LiveAuthPage mode="signup"/>}/>
                <Route path="/reset" element={<LiveAuthPage mode="reset"/>}/>

                <Route element={<AppLayout/>}>
                  {/* Every route below resolves to the live screen when signed in,
                      and to the unchanged demo screen otherwise. */}
                  <Route path="/dashboard" element={<DashboardRoute demo={()=><Dashboard/>}/>}/>
                  <Route path="/league" element={<ModeSwitch live={()=><LiveLeagueOverview/>} demo={()=><LeagueOverview/>}/>}/>
                  <Route path="/create-league" element={<ModeSwitch live={()=><LiveLeagueForm/>} demo={()=><LeagueForm/>}/>}/>
                  <Route path="/join-league" element={<ModeSwitch live={()=><LiveLeagueForm join/>} demo={()=><LeagueForm join/>}/>}/>
                  <Route path="/market" element={<ModeSwitch live={()=><LiveMarket/>} demo={()=><Market/>}/>}/>
                  <Route path="/players/:id" element={<ModeSwitch live={()=><LivePlayerProfile/>} demo={()=><PlayerProfile/>}/>}/>
                  <Route path="/suggest" element={<ModeSwitch live={()=><LiveSuggestPlayer/>} demo={()=><SuggestPlayer/>}/>}/>
                  <Route path="/management" element={<ModeSwitch live={()=><LiveManagement/>} demo={()=><Management/>}/>}/>
                  <Route path="/approvals" element={<ModeSwitch live={()=><LiveApprovals/>} demo={()=><Approvals/>}/>}/>
                  <Route path="/squad" element={<ModeSwitch live={()=><LiveSquad/>} demo={()=><SquadPage/>}/>}/>
                  <Route path="/squad-builder" element={<ModeSwitch live={()=><LiveSquad builder/>} demo={()=><SquadPage builder/>}/>}/>
                  <Route path="/transfers" element={<ModeSwitch live={()=><LiveSquad transfers/>} demo={()=><SquadPage transfers/>}/>}/>
                  <Route path="/fixtures" element={<ModeSwitch live={()=><LiveFixtures/>} demo={()=><Fixtures/>}/>}/>
                  <Route path="/match-center" element={<ModeSwitch live={()=><LiveMatchCenter/>} demo={()=><MatchCenter/>}/>}/>
                  <Route path="/match-center/:matchId" element={<ModeSwitch live={()=><LiveMatchCenter/>} demo={()=><MatchCenter/>}/>}/>
                  <Route path="/head-to-head" element={<ModeSwitch live={()=><LiveFixtures/>} demo={()=><Fixtures head/>}/>}/>
                  <Route path="/standings" element={<ModeSwitch live={()=><LiveStandings/>} demo={()=><Standings/>}/>}/>
                  <Route path="/statistics" element={<ModeSwitch live={()=><LiveSeason/>} demo={()=><Statistics/>}/>}/>
                  <Route path="/points" element={<ModeSwitch live={()=><LiveStandings/>} demo={()=><Statistics points/>}/>}/>
                  <Route path="/profile" element={<Profile/>}/>
                  <Route path="/settings" element={<SettingsPage/>}/>
                  <Route path="/notifications" element={<ModeSwitch live={()=><LiveNotifications/>} demo={()=><Notifications/>}/>}/>
                </Route>
                <Route path="*" element={<Navigate to="/dashboard" replace/>}/>
              </Routes>
            </Router>
          </LiveData>
        </DemoProvider>
      </AppModeProvider>
    </AuthProvider>
  </React.StrictMode>
);
