import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type SetStateAction } from 'react';
import { initialState } from '../data/demo';
import { saveLocalImage, commitLocalImage, discardDraftImage, deleteLocalImage, isLocalImage } from '../services/image';
import { canAddPlayer, defaultFormation, formations, reviewSuggestion, saveMarketPlayer, setMarketStatus, submitSuggestion, transferPlayer, validateSquad } from '../services/rules';
import type { DemoState, Player, Position, Squad, Suggestion } from '../types';
const KEY = 'fantasy-friends-demo-v1';
function persistDemo(next: DemoState): boolean { try { localStorage.setItem(KEY, JSON.stringify(next)); return true; } catch { return false; } }
function cleanupImages(previous: DemoState, next: DemoState) { const used = new Set([...next.players, ...next.suggestions].map(item => item.image)); const old = new Set([...previous.players, ...previous.suggestions].map(item => item.image)); for (const ref of old) if (ref && isLocalImage(ref) && !used.has(ref)) void deleteLocalImage(ref); }
function load(): DemoState {
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? JSON.parse(raw) as DemoState : initialState;
    if (!Array.isArray(saved.leagues) || !Array.isArray(saved.players) || !Array.isArray(saved.squads) || !Array.isArray(saved.suggestions)) return initialState;
    return { ...saved, squads: saved.squads.map(s => ({ ...s, formation: s.formation && formations[s.formation] ? s.formation : defaultFormation })) };
  } catch { return initialState; }
}
function useDemoStore() {
  const [state, reactSetState] = useState<DemoState>(load);
  const current = useRef(state);
  const setState = (action: SetStateAction<DemoState>) => {
    const next = typeof action === 'function' ? action(current.current) : action;
    current.current = next;
    reactSetState(next);
  };
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* Demo remains usable without storage. */ } }, [state]);
  // Migrate pre-IndexedDB demo photos without dropping them if storage is unavailable.
  useEffect(() => {
    let active = true;
    const legacy = [...new Set([...current.current.players, ...current.current.suggestions].map(item => item.image).filter((image): image is string => !!image && image.startsWith('data:image/')))];
    void (async () => {
      for (const old of legacy) {
        let ref: string | undefined;
        try {
          const blob = await (await fetch(old)).blob();
          ref = await saveLocalImage(blob);
          if (!active) { await discardDraftImage(ref); continue; }
          const s = current.current;
          const contains = [...s.players, ...s.suggestions].some(item => item.image === old);
          if (!contains) { await discardDraftImage(ref); continue; }
          const next = { ...s, players: s.players.map(p => p.image === old ? {...p, image: ref} : p), suggestions: s.suggestions.map(p => p.image === old ? {...p, image: ref} : p) };
          if (!persistDemo(next)) { await discardDraftImage(ref); continue; }
          commitLocalImage(ref); setState(next);
        } catch { if (ref) await discardDraftImage(ref); }
      }
    })();
    return () => { active = false; };
  }, []);

  const league = state.leagues.find(l => l.id === state.leagueId) ?? state.leagues[0];
  const players = state.players.filter(p => p.leagueId === league.id);
  const squad: Squad = state.squads.find(s => s.leagueId === league.id && s.managerId === state.role) ?? { leagueId: league.id, managerId: state.role, playerIds: [], formation: defaultFormation };
  const getSquad = (s: DemoState): Squad => s.squads.find(q => q.leagueId === s.leagueId && q.managerId === s.role) ?? { leagueId: s.leagueId, managerId: s.role, playerIds: [], formation: defaultFormation };
  const persistSquad = (s: DemoState, next: Squad): DemoState => ({ ...s, squads: [...s.squads.filter(q => !(q.leagueId === s.leagueId && q.managerId === s.role)), next] });
  const updateSquad = (patch: Partial<Squad>) => {
    const s = current.current; const old = getSquad(s); const next = { ...old, ...patch, confirmed: false };
    if (next.leagueId !== s.leagueId || next.managerId !== s.role || next.playerIds.length !== old.playerIds.length || next.playerIds.some(id => !old.playerIds.includes(id)) || next.playerIds.length > 15 || new Set(next.playerIds).size !== next.playerIds.length || next.playerIds.some(id => !s.players.some(p => p.id === id && p.leagueId === s.leagueId)) || (next.formation && !formations[next.formation]) || (next.captainId && !next.playerIds.includes(next.captainId)) || (next.viceCaptainId && !next.playerIds.includes(next.viceCaptainId)) || (next.captainId && next.captainId === next.viceCaptainId)) return false;
    setState(persistSquad(s, next)); return true;
  };
  const addPlayer = (player: Player) => {
    const s = current.current; const currentLeague = s.leagues.find(l => l.id === s.leagueId); const team = getSquad(s);
    if (!currentLeague || !currentLeague.marketOpen) return 'marketClosed';
    const error = canAddPlayer(team.playerIds, player, s.players.filter(p => p.leagueId === s.leagueId), currentLeague.budget);
    if (error) return error;
    setState(persistSquad(s, { ...team, confirmed:false, playerIds: [...team.playerIds, player.id] })); return null;
  };
  const removePlayer = (id: string) => {
    const s = current.current; const team = getSquad(s);
    if (!team.playerIds.includes(id)) return false;
    setState(persistSquad(s, { ...team, confirmed: false, playerIds: team.playerIds.filter(p => p !== id), captainId: team.captainId === id ? undefined : team.captainId, viceCaptainId: team.viceCaptainId === id ? undefined : team.viceCaptainId }));
    return true;
  };
  const transfer = (outId: string, inId: string) => {
    const s = current.current; const currentLeague = s.leagues.find(l => l.id === s.leagueId);
    if (!currentLeague) return 'wrongLeague';
    const result = transferPlayer(getSquad(s), outId, inId, s.players, currentLeague.budget, currentLeague.marketOpen);
    if (result.error || !result.squad) return result.error || 'wrongLeague';
    setState(persistSquad(s, { ...result.squad, confirmed:false })); return null;
  };
  const confirmSquad = () => {
    const s = current.current; const team = getSquad(s); const currentLeague = s.leagues.find(l => l.id === s.leagueId);
    if (!currentLeague || validateSquad(team, s.players, currentLeague.budget).length) return false;
    setState(persistSquad(s, {...team, confirmed:true})); return true;
  };
  const suggest = (name: string, position: Position, notes: string, image?: string) => {
    const s = current.current;
    const suggestion: Suggestion = { id: crypto.randomUUID(), leagueId: s.leagueId, name: name.trim(), position, notes, image, status: 'pending', submittedBy: s.role };
    try { const next = { ...s, suggestions: submitSuggestion(s.role, suggestion, s.leagueId, s.players, s.suggestions) }; if (!persistDemo(next)) return false; setState(next); return true; } catch { return false; }
  };
  const review = (suggestion: Suggestion, decision: 'approved' | 'rejected', player?: Player, reason = '') => {
    const s = current.current;
    try { const result = reviewSuggestion(s.role, suggestion, decision, s.players, s.suggestions, player, s.leagueId, reason); const next = { ...s, ...result }; if (!persistDemo(next)) return false; setState(next); return true; } catch { return false; }
  };
  const savePlayer = (player: Player) => {
    const s = current.current;
    try { const next = { ...s, players: saveMarketPlayer(s.role, s.leagueId, player, s.players, s.suggestions) }; if (!persistDemo(next)) return false; setState(next); cleanupImages(s, next); return true; } catch { return false; }
  };
  const setMarketOpen = (open: boolean) => {
    const s = current.current;
    try { setState(setMarketStatus(s, s.leagueId, open)); return true; } catch { return false; }
  };
  return { state, setState, league, players, squad, updateSquad, addPlayer, removePlayer, transfer, confirmSquad, suggest, review, savePlayer, setMarketOpen, reset: () => { const previous = current.current; const saved = persistDemo(initialState); setState(initialState); if (saved) cleanupImages(previous, initialState); } };
}
type Store = ReturnType<typeof useDemoStore>;
const Context = createContext<Store | null>(null);
export function DemoProvider({ children }: { children: ReactNode }) { const store = useDemoStore(); return <Context.Provider value={store}>{children}</Context.Provider>; }
export function useDemo() { const value = useContext(Context); if (!value) throw new Error('DemoProvider required'); return value; }
