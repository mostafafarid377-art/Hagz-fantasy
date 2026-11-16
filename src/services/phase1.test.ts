import { describe, expect, it } from 'vitest';
import { demoPlayers, initialState } from '../data/demo';
import { canAddPlayer, canManage, formations, reviewSuggestion, saveMarketPlayer, setMarketStatus, squadSummary, submitSuggestion, transferPlayer, validateSquad } from './rules';
import { filterMarket, ownershipCount, type MarketFilters } from './market';
import type { Formation, Player, Squad, Suggestion } from '../types';
const team = initialState.squads[0];
const players = initialState.players;
const filters: MarketFilters = {search:'',position:'All',price:'All',rating:'All',status:'All',sort:'Highest rated'};

describe('complete squad validation', () => {
  it('starts with a valid 15-player 4-3-3 squad under 100M', () => {
    expect(validateSquad(team, players)).toEqual([]);
    expect(squadSummary(team.playerIds, players)).toMatchObject({size:15,value:95.5,remaining:4.5,counts:{GK:2,DEF:5,MID:5,FWD:3}});
  });
  it('detects incomplete squad, lineup, position distribution, bench and missing captain', () => {
    const partial = {...team,playerIds:team.playerIds.slice(0,9),captainId:undefined,viceCaptainId:undefined};
    expect(validateSquad(partial,players)).toEqual(expect.arrayContaining(['squadSize','positionDistribution','startingSize','benchSize','captainMissing','viceMissing']));
  });
  it('detects duplicate players, bad budget, and a foreign player', () => {
    const duplicate = {...team,playerIds:[...team.playerIds.slice(0,14),team.playerIds[0]]};
    expect(validateSquad(duplicate,players,20)).toEqual(expect.arrayContaining(['duplicatePlayer','overBudget']));
    expect(validateSquad({...team,playerIds:[...team.playerIds.slice(0,14),'f-p1']},players)).toContain('unknownPlayer');
  });
  it('validates the goalkeeper and the requested formation without dropping players', () => {
    expect(validateSquad({...team,formation:'4-4-2'},players)).toContain('formationMismatch');
    const ids=[...team.playerIds]; [ids[0],ids[13]]=[ids[13],ids[0]];
    expect(validateSquad({...team,playerIds:ids},players)).toContain('startingGoalkeeper');
    const switched=[...team.playerIds]; [switched[10],switched[13]]=[switched[13],switched[10]];
    expect(validateSquad({...team,formation:'4-4-2',playerIds:switched},players)).toEqual([]);
  });
  it('requires distinct captains in the squad', () => {
    expect(validateSquad({...team,captainId:team.viceCaptainId},players)).toContain('captainsSame');
    expect(validateSquad({...team,captainId:'f-p1',viceCaptainId:'missing'},players)).toEqual(expect.arrayContaining(['captainMissing','viceMissing']));
  });
  it('defines seven formations with exactly one keeper and ten outfield players', () => {
    expect(Object.keys(formations)).toHaveLength(7);
    for (const formation of Object.values(formations)) expect(Object.values(formation).reduce((a,b)=>a+b,0)).toBe(11);
    expect((Object.keys(formations) as Formation[]).every(f=>formations[f].GK===1)).toBe(true);
  });
  it('prevents duplicates within a team and allows multiple managers to own the same player', () => {
    expect(canAddPlayer(['p1'],demoPlayers[0],demoPlayers)).toBe('alreadySelected');
    const differentSquads:Squad[]=[{leagueId:'league-1',managerId:'one',playerIds:['p1']},{leagueId:'league-1',managerId:'two',playerIds:['p1']}];
    expect(ownershipCount('p1','league-1',differentSquads)).toBe(2);
    expect(canAddPlayer([],demoPlayers[0],demoPlayers)).toBeNull();
  });
});
describe('league-scoped market', () => {
  it('searches, combines filters and handles empty results', () => {
    expect(filterMarket(players,'league-1',[],{...filters,search:'  fares '})).toHaveLength(1);
    expect(filterMarket(players,'league-1',[],{...filters,position:'GK',price:'Over 9M'})).toHaveLength(0);
    expect(filterMarket(players,'league-1',[],{...filters,rating:'90+ rating'}).every(p=>p.rating>=90)).toBe(true);
  });
  it('filters active and inactive players and never allows inactive additions', () => {
    const inactive={...demoPlayers[0],active:false};const list=[inactive,...demoPlayers.slice(1)];
    expect(filterMarket(list,'league-1',[],{...filters,status:'Inactive'})).toEqual([inactive]);
    expect(canAddPlayer([],inactive,list)).toBe('inactive');
  });
  it('sorts by price, rating and ownership without leaking another league', () => {
    const squads=[{leagueId:'league-1',managerId:'one',playerIds:['p2']},{leagueId:'league-1',managerId:'two',playerIds:['p2']},{leagueId:'league-2',managerId:'other',playerIds:['p1']}];
    expect(filterMarket(players,'league-1',squads,{...filters,sort:'Most owned'})[0].id).toBe('p2');
    const priced=filterMarket(players,'league-1',squads,{...filters,sort:'Price: low to high'});
    expect(priced[0].price).toBeLessThanOrEqual(priced[1].price);
    const rated=filterMarket(players,'league-2',squads,{...filters,sort:'Lowest rated'});
    expect(rated.every(p=>p.leagueId==='league-2')).toBe(true);expect(rated[0].rating).toBeLessThanOrEqual(rated[1].rating);
    expect(ownershipCount('p1','league-1',squads)).toBe(0);
  });
});
describe('suggestions and leader permissions', () => {
  const suggestion:Suggestion={id:'new',leagueId:'league-1',name:'Hatem Fathy',position:'MID',notes:'',status:'pending',submittedBy:'manager'};
  const player:Player={...demoPlayers[8],id:'new-player',name:suggestion.name};
  it('allows separate same-name pending suggestions while restricting roles', () => {
    const list=submitSuggestion('manager',suggestion,'league-1',players,[]);expect(list).toHaveLength(1);
    expect(submitSuggestion('manager',{...suggestion,id:'another',name:'  HATEM FATHY '},'league-1',players,list)).toHaveLength(2);
    expect(()=>submitSuggestion('leader',suggestion,'league-1',players,[])).toThrow('forbidden');
  });
  it('approves exactly one player and rejects repeated or stale approval', () => {
    const result=reviewSuggestion('leader',suggestion,'approved',players,[suggestion],player,'league-1');
    expect(result.players.filter(p=>p.id==='new-player')).toHaveLength(1);
    expect(()=>reviewSuggestion('leader',suggestion,'approved',result.players,result.suggestions,player,'league-1')).toThrow('already reviewed');
  });
  it('rejects with feedback without adding a player', () => {
    const result=reviewSuggestion('leader',suggestion,'rejected',players,[suggestion],undefined,'league-1','Not available');
    expect(result.players).toHaveLength(players.length);expect(result.suggestions[0]).toMatchObject({status:'rejected',rejectionReason:'Not available'});
  });
  it('enforces leader-only publication, edits, activation and market control', () => {
    expect(()=>saveMarketPlayer('manager','league-1',player,players,[])).toThrow('forbidden');
    expect(()=>saveMarketPlayer('leader','league-2',player,players,[])).toThrow('forbidden');
    const updated=saveMarketPlayer('leader','league-1',{...demoPlayers[0],active:false},players,[]);
    expect(updated.find(p=>p.id==='p1')?.active).toBe(false);
    expect(()=>setMarketStatus(initialState,'league-1',false)).toThrow('forbidden');
    const leader={...initialState,role:'leader' as const};
    expect(setMarketStatus(leader,'league-1',false).leagues[0].marketOpen).toBe(false);
    expect(()=>setMarketStatus(leader,'league-2',false)).toThrow('forbidden');
  });
  it('prevents manager and other-league reviews and rejects invalid details', () => {
    expect(canManage('manager')).toBe(false);expect(canManage('leader','a','a')).toBe(true);expect(canManage('leader','a','b')).toBe(false);
    expect(()=>reviewSuggestion('manager',suggestion,'approved',players,[suggestion],player,'league-1')).toThrow('forbidden');
    expect(()=>reviewSuggestion('leader',suggestion,'approved',players,[suggestion],player,'league-2')).toThrow('forbidden');
    expect(()=>reviewSuggestion('leader',suggestion,'approved',players,[suggestion],{...player,rating:999},'league-1')).toThrow();
  });
});
describe('atomic transfers', () => {
  it('replaces a player in the same slot and updates budget', () => {
    const result=transferPlayer(team,'p15','p17',players,100);expect(result.error).toBeUndefined();expect(result.squad?.playerIds[8]).toBe('p17');expect(result.squad?.captainId).toBeUndefined();
    expect(squadSummary(result.squad!.playerIds,players).remaining).toBe(6);
  });
  it('blocks different position, duplicate, inactive, foreign league and closed market', () => {
    expect(transferPlayer(team,'p15','p11',players,100).error).toBe('transferPosition');
    expect(transferPlayer(team,'p15','p18',players,100).error).toBe('alreadySelected');
    expect(transferPlayer(team,'p15','f-p1',players,100).error).toBe('wrongLeague');
    expect(transferPlayer(team,'p15','p17',players.map(p=>p.id==='p17'?{...p,active:false}:p),100).error).toBe('inactive');
    expect(transferPlayer(team,'p15','p17',players,100,false).error).toBe('marketClosed');
    expect(transferPlayer(team,'p18','p16',players,95.5).error).toBe('overBudget');
  });
});
