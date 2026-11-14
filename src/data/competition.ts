// Ranking is based only on fantasy totals. Equal totals share a rank; stable
// input order is retained for display without inventing a secondary tiebreaker.
export function rankFantasyStandings<T extends { fantasy: number }>(rows: readonly T[]) {
  return [...rows].sort((a,b)=>b.fantasy-a.fantasy).map((team,_index,sorted)=>({team,rank:sorted.findIndex(row=>row.fantasy===team.fantasy)+1}));
}
