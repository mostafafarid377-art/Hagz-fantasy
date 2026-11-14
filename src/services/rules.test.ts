import { describe, expect, it } from 'vitest';
import { demoPlayers, initialState } from '../data/demo';
import { canAddPlayer, canManage, isDuplicateName, reviewSuggestion, squadSummary } from './rules';
import type { Player } from '../types';
const players=demoPlayers;
describe('squad rules',()=>{
 it('enforces the 15 player squad limit',()=>{const ids=players.slice(0,15).map(p=>p.id);expect(canAddPlayer(ids,players[15],players,1000)).toBe('squadFull');});
 it('enforces the budget',()=>{expect(canAddPlayer([],players[14],players,10)).toBe('overBudget');expect(canAddPlayer([],players[14],players,11)).toBeNull();});
 it('counts positions and enforces distribution limits',()=>{const ids=['p1','p2'];expect(squadSummary(ids,players).counts.GK).toBe(2);expect(canAddPlayer(ids,players[18],players)).toBe('positionFull');});
 it('prevents duplicate ownership within one squad',()=>{expect(canAddPlayer(['p1'],players[0],players)).toBe('alreadySelected');});
 it('allows different managers to independently select the same player',()=>{expect(canAddPlayer([],players[0],players)).toBeNull();expect(canAddPlayer([],players[0],players)).toBeNull();});
});
describe('suggestions and permissions',()=>{
 const suggestion=initialState.suggestions[0];const player:Player={...players[0],id:'approved',name:suggestion.name,position:suggestion.position};
 it('restricts leader operations',()=>{expect(canManage('manager')).toBe(false);expect(canManage('leader')).toBe(true);expect(()=>reviewSuggestion('manager',suggestion,'approved',players,[suggestion],player)).toThrow('forbidden');});
 it('approves a pending suggestion and adds one market player',()=>{const result=reviewSuggestion('leader',suggestion,'approved',players,[suggestion],player);expect(result.suggestions[0].status).toBe('approved');expect(result.players[result.players.length-1]?.name).toBe(suggestion.name);});
 it('rejects without creating a player',()=>{const result=reviewSuggestion('leader',suggestion,'rejected',players,[suggestion]);expect(result.suggestions[0].status).toBe('rejected');expect(result.players).toHaveLength(players.length);});
 it('prevents duplicate names within a league, ignoring case and spaces',()=>{expect(isDuplicateName('  omar KHALED ', 'league-1',players,[])).toBe(true);expect(isDuplicateName('Hady Wael','league-1',players,[suggestion])).toBe(true);expect(isDuplicateName('Omar Khaled','another',players,[])).toBe(false);});
 it('prevents approval of an existing market name and re-review',()=>{expect(()=>reviewSuggestion('leader',suggestion,'approved',players,[suggestion],{...player,name:players[0].name})).toThrow('duplicate');expect(()=>reviewSuggestion('leader',{...suggestion,status:'rejected'},'approved',players,[suggestion],player)).toThrow('already reviewed');});
});
