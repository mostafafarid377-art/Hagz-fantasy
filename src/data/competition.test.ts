import { describe, expect, it } from 'vitest';
import { rankFantasyStandings } from './competition';
describe('fantasy standings',()=>{
  it('ranks solely by fantasy points and gives equal totals the same rank',()=>{
    const input=[{name:'A',fantasy:20,points:99},{name:'B',fantasy:50,points:0},{name:'C',fantasy:50,points:4},{name:'D',fantasy:10,points:100}];
    expect(rankFantasyStandings(input).map(({team,rank})=>[team.name,rank])).toEqual([['B',1],['C',1],['A',3],['D',4]]);
    expect(input.map(x=>x.name)).toEqual(['A','B','C','D']);
  });
});
