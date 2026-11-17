import { validImageValue } from '../utils/image';
import type { DemoState, Formation, Player, Position, Role, Suggestion, Squad } from '../types';

export const limits: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
export const formations: Partial<Record<Formation, Record<Position, number>>> = {
  '4-3-3': { GK: 1, DEF: 4, MID: 3, FWD: 3 },
  '4-4-2': { GK: 1, DEF: 4, MID: 4, FWD: 2 },
  '3-5-2': { GK: 1, DEF: 3, MID: 5, FWD: 2 },
  '3-4-3': { GK: 1, DEF: 3, MID: 4, FWD: 3 },
  '4-5-1': { GK: 1, DEF: 4, MID: 5, FWD: 1 },
  '5-3-2': { GK: 1, DEF: 5, MID: 3, FWD: 2 },
  '5-4-1': { GK: 1, DEF: 5, MID: 4, FWD: 1 },
};
export const defaultFormation: Formation = '4-3-3';
const positions = Object.keys(limits) as Position[];
export function squadSummary(ids: string[], players: Player[], budget = 100) {
  const selected = ids.map(id => players.find(p => p.id === id)).filter((p): p is Player => !!p);
  const value = Math.round(selected.reduce((sum, p) => sum + p.price, 0) * 100) / 100;
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  selected.forEach(p => counts[p.position]++);
  return { selected, value, remaining: Math.round((budget - value) * 100) / 100, counts, size: selected.length };
}
export function canAddPlayer(ids: string[], player: Player, players: Player[], budget = 100): string | null {
  const canonical = players.find(p => p.id === player.id);
  if (!canonical || canonical.leagueId !== player.leagueId) return 'wrongLeague';
  const s = squadSummary(ids, players, budget);
  if (ids.includes(canonical.id)) return 'alreadySelected';
  if (ids.length >= 15) return 'squadFull';
  if (!canonical.active) return 'inactive';
  if (s.value + canonical.price > budget + 1e-9) return 'overBudget';
  if (s.counts[canonical.position] >= limits[canonical.position]) return 'positionFull';
  return null;
}
export type SquadIssue = 'squadSize' | 'duplicatePlayer' | 'unknownPlayer' | 'overBudget' | 'positionDistribution' | 'startingSize' | 'startingGoalkeeper' | 'formationMismatch' | 'benchSize' | 'captainMissing' | 'viceMissing' | 'captainsSame';
export function validateSquad(squad: Squad, players: Player[], budget = 100): SquadIssue[] {
  const issues: SquadIssue[] = [];
  const scoped = players.filter(p => p.leagueId === squad.leagueId);
  const summary = squadSummary(squad.playerIds, scoped, budget);
  const starting = squadSummary(squad.playerIds.slice(0, 11), scoped, budget);
  const formation = formations[squad.formation || defaultFormation] || formations[defaultFormation]!;
  if (squad.playerIds.length !== 15) issues.push('squadSize');
  if (new Set(squad.playerIds).size !== squad.playerIds.length) issues.push('duplicatePlayer');
  if (summary.size !== squad.playerIds.length) issues.push('unknownPlayer');
  if (summary.remaining < 0) issues.push('overBudget');
  if (positions.some(p => summary.counts[p] !== limits[p])) issues.push('positionDistribution');
  if (starting.size !== 11) issues.push('startingSize');
  if (starting.counts.GK !== 1) issues.push('startingGoalkeeper');
  if (positions.some(p => starting.counts[p] !== formation[p])) issues.push('formationMismatch');
  if (squad.playerIds.slice(11).length !== 4) issues.push('benchSize');
  if (!squad.captainId || !squad.playerIds.includes(squad.captainId)) issues.push('captainMissing');
  if (!squad.viceCaptainId || !squad.playerIds.includes(squad.viceCaptainId)) issues.push('viceMissing');
  if (squad.captainId && squad.captainId === squad.viceCaptainId) issues.push('captainsSame');
  return issues;
}
// A guided substitution cannot make the chosen formation less accurate. This
// allows same-position swaps in a valid lineup and corrective swaps in a draft.
export function substitutionTargets(squad: Squad, players: Player[], sourceId: string): string[] {
  const source = squad.playerIds.indexOf(sourceId);
  if (source < 0) return [];
  const scoped = players.filter(p => p.leagueId === squad.leagueId);
  const desired = formations[squad.formation || defaultFormation] || formations[defaultFormation]!;
  const difference = (ids:string[]) => {
    const actual=squadSummary(ids.slice(0,11),scoped).counts;
    return positions.reduce((total,pos)=>total+Math.abs(actual[pos]-desired[pos]),0);
  };
  const before=difference(squad.playerIds);
  const original = scoped.find(p=>p.id===sourceId);
  if (!original) return [];
  return squad.playerIds.filter((id,index)=>{
    if ((source<11)===(index<11) || !scoped.some(p=>p.id===id)) return false;
    const next=[...squad.playerIds];[next[source],next[index]]=[next[index],next[source]];
    return scoped.find(p=>p.id===id)?.position===original.position || difference(next)<before;
  });
}
export function transferPlayer(squad: Squad, outId: string, inId: string, players: Player[], budget: number, marketOpen = true): { squad?: Squad; error?: string } {
  if (!marketOpen) return { error: 'marketClosed' };
  const outgoing = players.find(p => p.id === outId && p.leagueId === squad.leagueId);
  const incoming = players.find(p => p.id === inId && p.leagueId === squad.leagueId);
  if (!outgoing || !squad.playerIds.includes(outId) || !incoming) return { error: 'wrongLeague' };
  if (!incoming.active) return { error: 'inactive' };
  if (squad.playerIds.includes(inId)) return { error: 'alreadySelected' };
  if (incoming.position !== outgoing.position) return { error: 'transferPosition' };
  const nextIds = squad.playerIds.map(id => id === outId ? inId : id);
  if (squadSummary(nextIds, players.filter(p => p.leagueId === squad.leagueId), budget).remaining < 0) return { error: 'overBudget' };
  return { squad: { ...squad, playerIds: nextIds, captainId: squad.captainId === outId ? undefined : squad.captainId, viceCaptainId: squad.viceCaptainId === outId ? undefined : squad.viceCaptainId } };
}
export const canManage = (role: Role, currentLeagueId?: string, resourceLeagueId?: string) => role === 'leader' && (!resourceLeagueId || currentLeagueId === resourceLeagueId);
export function submitSuggestion(role: Role, suggestion: Suggestion, currentLeagueId: string, _players: Player[], suggestions: Suggestion[]) {
  if (role !== 'manager' || suggestion.submittedBy !== 'manager' || suggestion.leagueId !== currentLeagueId) throw new Error('forbidden');
  if (suggestions.some(s => s.id === suggestion.id) || !positions.includes(suggestion.position) || suggestion.notes.length > 500 || !validImageValue(suggestion.image || '') || suggestion.name.trim().length < 2 || suggestion.status !== 'pending') throw new Error('duplicate');
  return [...suggestions, suggestion];
}
export function validPlayer(player: Player): boolean {
  return validImageValue(player.image || '') && player.name.trim().length >= 2 && positions.includes(player.position) && Number.isFinite(player.price) && player.price > 0 && player.price <= 100 && Number.isInteger(player.rating) && player.rating >= 1 && player.rating <= 99 && (['pace','shooting','passing','defending','physical'] as const).every(k => Number.isInteger(player.attributes[k]) && player.attributes[k] >= 1 && player.attributes[k] <= 99);
}
export function reviewSuggestion(role: Role, suggestion: Suggestion, decision: 'approved' | 'rejected', players: Player[], suggestions: Suggestion[], player?: Player, currentLeagueId = suggestion.leagueId, rejectionReason = '') {
  const current = suggestions.find(s => s.id === suggestion.id);
  if (!current || !canManage(role, currentLeagueId, current.leagueId)) throw new Error('forbidden');
  if (current.status !== 'pending') throw new Error('already reviewed');
  if (decision === 'approved' && (!player || player.leagueId !== currentLeagueId || !validPlayer(player) || !player.active || players.some(p => p.id === player.id))) throw new Error('duplicate');
  return { suggestions: suggestions.map(s => s.id === current.id ? { ...s, status: decision, rejectionReason: decision === 'rejected' ? rejectionReason.trim() : undefined } : s), players: decision === 'approved' && player ? [...players, player] : players };
}

export function saveMarketPlayer(role: Role, currentLeagueId: string, player: Player, players: Player[], _suggestions: Suggestion[]): Player[] {
  if (!canManage(role, currentLeagueId, player.leagueId)) throw new Error('forbidden');
  if (!validPlayer(player)) throw new Error('invalidPlayer');
  const existing = players.find(p => p.id === player.id);
  if (existing && existing.leagueId !== currentLeagueId) throw new Error('forbidden');
  return [...players.filter(p => p.id !== player.id), player];
}
export function setMarketStatus(state: DemoState, leagueId: string, marketOpen: boolean): DemoState {
  if (!canManage(state.role, state.leagueId, leagueId) || !state.leagues.some(l => l.id === leagueId)) throw new Error('forbidden');
  return { ...state, leagues: state.leagues.map(l => l.id === leagueId ? { ...l, marketOpen } : l) };
}
