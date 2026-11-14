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
import AppLayout from './layouts/AppLayout';
import Dashboard from './pages/Dashboard';
import { Approvals, AuthPage, Management, Market, PlayerProfile, SuggestPlayer } from './pages/Players';
import { SquadPage } from './pages/Squad';
import { Fixtures, MatchCenter, Standings, Statistics } from './pages/Competition';
import { LeagueForm, LeagueOverview, Notifications, Profile, SettingsPage } from './pages/Other';
// GitHub Pages cannot rewrite arbitrary paths to index.html, so its build uses
// hash routing. Other deployments keep normal browser history URLs.
const Router = import.meta.env.VITE_ROUTER_MODE === 'hash' ? HashRouter : BrowserRouter;

function LanguageDirection(){const {i18n}=useTranslation();useEffect(()=>{document.documentElement.lang=i18n.language;document.documentElement.dir=i18n.language==='ar'?'rtl':'ltr';localStorage.setItem('ff-language',i18n.language);},[i18n.language]);return null;}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><DemoProvider><LanguageDirection/><Router basename={import.meta.env.VITE_ROUTER_MODE === 'hash' ? undefined : import.meta.env.BASE_URL}><Routes><Route path="/" element={<AuthPage type="landing"/>}/><Route path="/login" element={<AuthPage type="login"/>}/><Route path="/signup" element={<AuthPage type="signup"/>}/><Route element={<AppLayout/>}><Route path="/dashboard" element={<Dashboard/>}/><Route path="/league" element={<LeagueOverview/>}/><Route path="/create-league" element={<LeagueForm/>}/><Route path="/join-league" element={<LeagueForm join/>}/><Route path="/market" element={<Market/>}/><Route path="/players/:id" element={<PlayerProfile/>}/><Route path="/suggest" element={<SuggestPlayer/>}/><Route path="/management" element={<Management/>}/><Route path="/approvals" element={<Approvals/>}/><Route path="/squad" element={<SquadPage/>}/><Route path="/squad-builder" element={<SquadPage builder/>}/><Route path="/transfers" element={<SquadPage transfers/>}/><Route path="/fixtures" element={<Fixtures/>}/><Route path="/match-center" element={<MatchCenter/>}/><Route path="/match-center/:matchId" element={<MatchCenter/>}/><Route path="/head-to-head" element={<Fixtures head/>}/><Route path="/standings" element={<Standings/>}/><Route path="/statistics" element={<Statistics/>}/><Route path="/points" element={<Statistics points/>}/><Route path="/profile" element={<Profile/>}/><Route path="/settings" element={<SettingsPage/>}/><Route path="/notifications" element={<Notifications/>}/></Route><Route path="*" element={<Navigate to="/dashboard" replace/>}/></Routes></Router></DemoProvider></React.StrictMode>);
