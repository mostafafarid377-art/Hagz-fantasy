// Wire types for the database API.
//
// These mirror the JSON shapes returned by the ff_* RPCs (migration 012), not the
// raw table rows: the RPCs join and reshape so the client never needs to know
// about player_profiles vs league_players, or snake_case FK pairs.
//
// Money is transported as a NUMERIC and arrives as a JSON number. The values we
// use (a 100M budget, prices in single millions) are well inside the exact-integer
// range of a double, but any arithmetic that must be exact is done server-side -
// the client only displays, and compares with a tolerance.

export type Position = 'GK' | 'DEF' | 'MID' | 'FWD';
export type Formation = '4-3-3' | '4-4-2' | '3-5-2' | '3-4-3' | '4-5-1' | '5-3-2' | '5-4-1';
export type LeagueRole = 'leader' | 'manager';

export interface ApiLeague {
  id: string;
  name: string;
  role: LeagueRole;
  budget: number;
  market_open: boolean;
}

export interface ApiMember {
  user_id: string;
  name: string;
  role: LeagueRole;
  status: 'active' | 'inactive';
  joined_at: string;
  team_id: string | null;
  team_name: string | null;
  is_organizer: boolean;
}

export interface ApiPlayer {
  id: string;            // league_players.id - the market row (use for squad actions)
  player_id: string;     // player_profiles.id - stable identity (use for edits)
  name: string;
  position: Position;
  price: number;
  rating: number;
  active: boolean;
  image_path: string | null;
  image_url: string | null;
  league_id: string;
  owned_by?: number;
  owned_by_me?: boolean;
}

export interface ApiSuggestion {
  id: string;
  name: string;
  position: Position;
  notes: string | null;
  status: 'pending' | 'approved' | 'rejected';
  image_path: string | null;
  image_url: string | null;
  submitted_by: string;
  submitted_by_name: string | null;
  league_player_id: string | null;
  created_at: string;
  rejection_reason: string | null;
}

export interface ApiSquadPlayer {
  league_player_id: string;
  name: string;
  position: Position;
  price: number;
  rating: number;
  image_path: string | null;
  image_url: string | null;
  active: boolean;
  slot: number | null;
  captain: boolean;
  vice_captain: boolean;
}

export interface ApiSquad {
  team: { id: string; name: string } | null;
  lineup_id?: string;
  formation: Formation | null;
  status: 'empty' | 'draft' | 'confirmed' | 'superseded';
  version?: number;
  gameweek_id?: string;
  captain_id: string | null;
  vice_captain_id: string | null;
  players: ApiSquadPlayer[];
  budget: number;
  spent: number;
}

export interface ApiMatchEvent {
  id: string;
  type: string;
  minute: number | null;
  quantity: number;
  player_id: string;
  player_name: string | null;
  related_player_id?: string | null;
}

export interface ApiMatchLineupPlayer {
  player_id: string;
  name: string;
  selection: 'starter' | 'substitute';
  actual_position: Position;
}

export interface ApiMatchSubmission {
  id: string;
  kind: 'lineup' | 'result';
  submitted_by: string;
  submitted_at: string;
  approval: null | {
    id: string;
    decision: 'approved' | 'rejected';
    reason: string | null;
    reviewed_by: string;
    reviewed_at: string;
  };
}

export interface ApiMatchRevision {
  revision_id: string;
  version: number;
  state: 'draft' | 'submitted' | 'approved' | 'rejected' | 'corrected';
  team_a_score: number | null;
  team_b_score: number | null;
  submissions: ApiMatchSubmission[];
  events: ApiMatchEvent[];
  correction: null | { reason: string; actor_id: string; created_at: string };
  lineups: Array<{ team_id: string; players: ApiMatchLineupPlayer[] }>;
}

export interface ApiMatch {
  id: string;
  gameweek_id: string | null;
  starts_at: string;
  venue: string;
  team_a_id: string;
  team_a: string;
  team_b_id: string;
  team_b: string;
  organizer_id: string;
  starters_per_side: number;
  max_substitutes: number;
  revision_id: string | null;
  revision_version: number | null;
  revision_state: 'draft' | 'submitted' | 'approved' | 'rejected' | 'corrected' | null;
  team_a_score: number | null;
  team_b_score: number | null;
  events: ApiMatchEvent[];
  history: ApiMatchRevision[];
}

export interface ApiStanding {
  team_id: string;
  team_name: string;
  manager_id: string;
  manager_name: string | null;
  mode: 'fantasy_total' | 'head_to_head';
  fantasy_points: number;
  h2h_points: number | null;
  is_stale: boolean;
  computed_at: string;
}

export interface ApiNotification {
  id: string;
  league_id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
}
