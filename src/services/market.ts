import type { Player, Position, Squad } from '../types';
export type MarketSort = 'Highest rated' | 'Lowest rated' | 'Price: low to high' | 'Price: high to low' | 'Most points' | 'Most owned';
export interface MarketFilters { search: string; position: Position | 'All'; price: 'All' | 'Under 6M' | '6M–9M' | 'Over 9M'; rating: 'All' | '80+ rating' | '85+ rating' | '90+ rating'; status: 'All' | 'Active' | 'Inactive'; sort: MarketSort }
export function ownershipCount(id: string, leagueId: string, squads: Squad[]) { return squads.filter(s => s.leagueId === leagueId && s.playerIds.includes(id)).length; }
export function filterMarket(players: Player[], leagueId: string, squads: Squad[], filters: MarketFilters) {
  const search = filters.search.trim().toLocaleLowerCase();
  return players.filter(p => p.leagueId === leagueId && p.name.toLocaleLowerCase().includes(search) && (filters.status === 'All' || p.active === (filters.status === 'Active')) && (filters.position === 'All' || p.position === filters.position) && (filters.price === 'All' || (filters.price === 'Under 6M' ? p.price < 6 : filters.price === '6M–9M' ? p.price >= 6 && p.price <= 9 : p.price > 9)) && (filters.rating === 'All' || p.rating >= Number(filters.rating.slice(0, 2))))
    .sort((a,b) => filters.sort === 'Price: low to high' ? a.price-b.price : filters.sort === 'Price: high to low' ? b.price-a.price : filters.sort === 'Lowest rated' ? a.rating-b.rating : filters.sort === 'Most points' ? b.points-a.points : filters.sort === 'Most owned' ? ownershipCount(b.id,leagueId,squads)-ownershipCount(a.id,leagueId,squads) : b.rating-a.rating);
}
