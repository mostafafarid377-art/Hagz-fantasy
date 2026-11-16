import type { DemoState, Player, Position } from '../types';
const names = ['Omar Khaled','Karim Hassan','Youssef Adel','Ahmed Nabil','Ziad Tarek','Mahmoud Samir','Ali Hamdy','Seif Mostafa','Hassan Magdy','Marwan Salah','Omar Farouk','Adam Sherif','Fares Ashraf','Tamer Hany','Amr Hesham','Khaled Emad','Mazen Wael','Yassin Mohamed','Sherif Adel','Nour Ahmed','Samy Ibrahim','Ramy Fathy'];
const positions:Position[] = ['GK','GK','DEF','DEF','DEF','DEF','DEF','DEF','MID','MID','MID','MID','MID','MID','FWD','FWD','FWD','FWD','GK','DEF','MID','FWD'];
const prices=[5.5,4.5,6.5,6,5.5,5,4.5,4,9,8.5,8,7,6.5,5,11,10,9.5,7.5,4,4.5,5.5,6];
export const demoPlayers:Player[] = names.map((name,i)=>({id:`p${i+1}`,leagueId:'league-1',name,position:positions[i],price:prices[i],rating:[84,79,86,83,81,79,77,75,91,88,86,83,80,77,92,89,87,82,74,76,78,79][i],attributes:{pace:Math.min(96,70+(i*7)%23),shooting:Math.min(94,65+(i*11)%29),passing:Math.min(94,68+(i*9)%26),defending:Math.min(93,61+(i*13)%31),physical:Math.min(95,70+(i*5)%25)},points:[62,38,81,74,68,55,48,35,112,98,92,78,69,45,126,109,102,71,25,38,54,60][i],color:['#becab1','#c0a995','#9aaeb0','#c5b29e','#b3a98e'][i%5],active:true}));
export const initialState:DemoState={leagues:[{id:'league-1',name:'The Football Circle',leader:'Omar Khaled',season:'Season 2025/26',matchType:'7-a-side',budget:100,members:8,code:'CIRCLE26',marketOpen:true},{id:'league-2',name:'Friday Night League',leader:'Karim Hassan',season:'Season 2025/26',matchType:'5-a-side',budget:100,members:6,code:'FRIDAY26',marketOpen:true}],leagueId:'league-1',role:'manager',players:[...demoPlayers,...demoPlayers.map(p=>({...p,id:`f-${p.id}`,leagueId:'league-2'}))],suggestions:[{id:'s1',leagueId:'league-1',name:'Hady Wael',position:'MID',notes:'Great vision and always shows up on Fridays.',status:'pending',submittedBy:'manager'}],squads:[{leagueId:'league-1',managerId:'manager',playerIds:['p1','p3','p4','p5','p6','p9','p10','p13','p15','p18','p22','p19','p8','p14','p21'],formation:'4-3-3',confirmed:true,captainId:'p15',viceCaptainId:'p9'},{leagueId:'league-1',managerId:'leader',playerIds:['p1','p3','p9','p15'],captainId:'p9'}]};
export const standings=[{name:'The Invincibles',manager:'Karim Hassan',played:8,w:6,d:1,l:1,points:19,fantasy:624},{name:'Khaled FC',manager:'Omar Khaled',played:8,w:5,d:2,l:1,points:17,fantasy:598},{name:'Goal Diggers',manager:'You',played:8,w:5,d:1,l:2,points:16,fantasy:572},{name:'Net Six and Chill',manager:'Ahmed Nabil',played:8,w:4,d:1,l:3,points:13,fantasy:540},{name:'The Nutmeggers',manager:'Ziad Tarek',played:8,w:3,d:2,l:3,points:11,fantasy:512},{name:'Pitch Perfect',manager:'Ali Hamdy',played:8,w:2,d:2,l:4,points:8,fantasy:487},{name:'Weekend Warriors',manager:'Seif Mostafa',played:8,w:2,d:1,l:5,points:7,fantasy:461},{name:'No Kane No Gain',manager:'Marwan Salah',played:8,w:1,d:0,l:7,points:3,fantasy:420}];

// ---- last gameweek -------------------------------------------------------
//
// The demo only ever modelled SEASON TOTALS: `points` on a player and `fantasy`
// on a standing are cumulative. There is no per-gameweek history, so "last game
// points" cannot be derived from existing data - it has to be stated.
//
// These are the fictional Gameweek 08 returns for the starting XI. Each is a
// plausible single-week share of that player's season total (a test asserts none
// exceeds it). Their sum is derived below rather than written down, because a
// hardcoded total drifts the moment one value changes.
export const lastGameweek = 8;

const lastPointsByName: Record<string, number> = {
  // starting XI
  'Omar Khaled': 9,      // season 62
  'Youssef Adel': 12,    // season 81
  'Ahmed Nabil': 11,     // season 74
  'Ziad Tarek': 10,      // season 68
  'Mahmoud Samir': 8,    // season 55
  'Hassan Magdy': 17,    // season 112
  'Marwan Salah': 14,    // season 98
  'Fares Ashraf': 10,    // season 69
  'Amr Hesham': 19,      // season 126
  'Yassin Mohamed': 11,  // season 71
  'Ramy Fathy': 9,       // season 60
  // bench
  'Sherif Adel': 4,      // season 25
  'Seif Mostafa': 5,     // season 35
  'Tamer Hany': 7,       // season 45
  'Samy Ibrahim': 8,     // season 54
};

/** The eleven starters in the demo squad, in squad order. */
const STARTING_XI = [
  'Omar Khaled', 'Youssef Adel', 'Ahmed Nabil', 'Ziad Tarek', 'Mahmoud Samir',
  'Hassan Magdy', 'Marwan Salah', 'Fares Ashraf', 'Amr Hesham', 'Yassin Mohamed',
  'Ramy Fathy',
];

/** What the starting XI scored in the last gameweek, summed from the values above. */
export const STARTING_XI_TOTAL = STARTING_XI
  .reduce((sum, name) => sum + (lastPointsByName[name] ?? 0), 0);

/** The player's points in the most recent gameweek, not their season total. */
export function lastGameweekPoints(name: string): number {
  return lastPointsByName[name] ?? 0;
}

/**
 * A league's points in the most recent gameweek. A standing only carries a season
 * total, so this is stated alongside it. Your own row ties to the same 344 as the
 * starting XI above.
 */
export function lastGameweekTeamPoints(teamName: string): number {
  const byTeam: Record<string, number> = {
    'The Invincibles': 71,
    'Khaled FC': 64,
    'Goal Diggers': STARTING_XI_TOTAL,
    'Net Six and Chill': 58,
    'The Nutmeggers': 49,
    'Pitch Perfect': 55,
    'Weekend Warriors': 43,
    'No Kane No Gain': 38,
  };
  return byTeam[teamName] ?? 0;
}
