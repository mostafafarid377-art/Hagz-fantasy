import { describe, expect, it } from 'vitest';
import { initialState } from '../data/demo';
import { substitutionTargets } from './rules';
const squad=initialState.squads.find(s=>s.managerId==='manager'&&s.leagueId==='league-1')!;
describe('guided substitution candidates',()=>{
  it('offers only same-position swaps for a valid formation in both directions',()=>{
    expect(substitutionTargets(squad,initialState.players,'p3')).toEqual(['p8']);
    expect(substitutionTargets(squad,initialState.players,'p8')).toEqual(['p3','p4','p5','p6']);
    expect(substitutionTargets(squad,initialState.players,'p1')).toEqual(['p19']);
    expect(substitutionTargets(squad,initialState.players,'p22')).toEqual([]);
  });
  it('permits a corrective swap after a formation change without mutating the squad',()=>{
    const changed={...squad,formation:'4-4-2' as const};const original=[...changed.playerIds];
    expect(substitutionTargets(changed,initialState.players,'p22')).toEqual(['p14','p21']);
    expect(changed.playerIds).toEqual(original);
    expect(substitutionTargets(changed,initialState.players,'missing')).toEqual([]);
  });
});
