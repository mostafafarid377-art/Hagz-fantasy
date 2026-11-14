export type Position = 'GK' | 'DEF' | 'MID' | 'FWD';
export type Role = 'leader' | 'manager';
export type Formation = '4-3-3' | '4-4-2' | '3-5-2' | '3-4-3' | '4-5-1' | '5-3-2' | '5-4-1';
export type SuggestionStatus = 'pending' | 'approved' | 'rejected';
export interface Attributes { pace:number; shooting:number; passing:number; defending:number; physical:number }
export interface Player { id:string; leagueId:string; name:string; position:Position; price:number; rating:number; attributes:Attributes; image?:string; active:boolean; points:number; color:string }
export interface Suggestion { id:string; leagueId:string; name:string; position:Position; image?:string; notes:string; status:SuggestionStatus; submittedBy:string; rejectionReason?:string }
export interface League { id:string; name:string; leader:string; season:string; matchType:string; budget:number; members:number; code:string; marketOpen:boolean }
export interface Squad { leagueId:string; managerId:string; playerIds:string[]; formation?:Formation; confirmed?:boolean; captainId?:string; viceCaptainId?:string }
export interface DemoState { leagues:League[]; leagueId:string; role:Role; players:Player[]; suggestions:Suggestion[]; squads:Squad[] }
