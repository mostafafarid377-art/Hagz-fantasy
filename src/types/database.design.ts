// GENERATED FROM OFFLINE PHASE 2A DESIGN; not Supabase-generated or production-ready.
// Numeric fields follow PostgREST's number shape; validate exact-money transport before integration.
import type { Formation, Position } from './index';
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
export type DatabaseDesign = { public: { Tables: {
  audit_logs: {
    Row: {
      id: string;
      league_id: string;
      actor_id: string;
      action: string;
      entity_type: string;
      entity_id: string;
      before_data: Json | null;
      after_data: Json | null;
      reason: string | null;
      created_at: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      actor_id: string;
      action: string;
      entity_type: string;
      entity_id: string;
      before_data?: Json | null;
      after_data?: Json | null;
      reason?: string | null;
      created_at?: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      actor_id?: string;
      action?: string;
      entity_type?: string;
      entity_id?: string;
      before_data?: Json | null;
      after_data?: Json | null;
      reason?: string | null;
      created_at?: string;
    };
    Relationships: [{ foreignKeyName: "audit_logs_actor_id_fkey"; columns: ["actor_id"]; isOneToOne: false; referencedRelation: "profiles"; referencedColumns: ["id"] }, { foreignKeyName: "audit_logs_league_id_actor_id_fkey"; columns: ["league_id","actor_id"]; isOneToOne: false; referencedRelation: "league_members"; referencedColumns: ["league_id","user_id"] }, { foreignKeyName: "audit_logs_league_id_fkey"; columns: ["league_id"]; isOneToOne: false; referencedRelation: "leagues"; referencedColumns: ["id"] }];
  };
  fantasy_lineup_players: {
    Row: {
      league_id: string;
      lineup_id: string;
      league_player_id: string;
      position_snapshot: Position;
      price_snapshot: number | null;
      slot: number;
      captain: boolean;
      vice_captain: boolean;
    };
    Insert: {
      league_id: string;
      lineup_id: string;
      league_player_id: string;
      position_snapshot: Position;
      price_snapshot?: number | null;
      slot: number;
      captain?: boolean;
      vice_captain?: boolean;
    };
    Update: {
      league_id?: string;
      lineup_id?: string;
      league_player_id?: string;
      position_snapshot?: Position;
      price_snapshot?: number | null;
      slot?: number;
      captain?: boolean;
      vice_captain?: boolean;
    };
    Relationships: [{ foreignKeyName: "fantasy_lineup_players_league_id_league_player_id_fkey"; columns: ["league_id","league_player_id"]; isOneToOne: false; referencedRelation: "league_players"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "fantasy_lineup_players_league_id_lineup_id_fkey"; columns: ["league_id","lineup_id"]; isOneToOne: false; referencedRelation: "fantasy_lineups"; referencedColumns: ["league_id","id"] }];
  };
  fantasy_lineups: {
    Row: {
      id: string;
      league_id: string;
      fantasy_team_id: string;
      gameweek_id: string;
      version: number;
      status: 'draft' | 'confirmed' | 'superseded';
      formation: Formation;
      created_at: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      fantasy_team_id: string;
      gameweek_id: string;
      version: number;
      status: 'draft' | 'confirmed' | 'superseded';
      formation?: Formation;
      created_at?: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      fantasy_team_id?: string;
      gameweek_id?: string;
      version?: number;
      status?: 'draft' | 'confirmed' | 'superseded';
      formation?: Formation;
      created_at?: string;
    };
    Relationships: [{ foreignKeyName: "fantasy_lineups_league_id_fantasy_team_id_fkey"; columns: ["league_id","fantasy_team_id"]; isOneToOne: false; referencedRelation: "fantasy_teams"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "fantasy_lineups_league_id_gameweek_id_fkey"; columns: ["league_id","gameweek_id"]; isOneToOne: false; referencedRelation: "gameweeks"; referencedColumns: ["league_id","id"] }];
  };
  fantasy_score_items: {
    Row: {
      league_id: string;
      scoring_run_id: string;
      fantasy_lineup_id: string;
      performance_id: string;
      base_points: number;
      multiplier: number;
      points: number;
    };
    Insert: {
      league_id: string;
      scoring_run_id: string;
      fantasy_lineup_id: string;
      performance_id: string;
      base_points: number;
      multiplier: number;
      points: number;
    };
    Update: {
      league_id?: string;
      scoring_run_id?: string;
      fantasy_lineup_id?: string;
      performance_id?: string;
      base_points?: number;
      multiplier?: number;
      points?: number;
    };
    Relationships: [{ foreignKeyName: "fantasy_score_items_league_id_fantasy_lineup_id_fkey"; columns: ["league_id","fantasy_lineup_id"]; isOneToOne: false; referencedRelation: "fantasy_lineups"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "fantasy_score_items_league_id_performance_id_fkey"; columns: ["league_id","performance_id"]; isOneToOne: false; referencedRelation: "match_player_performances"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "fantasy_score_items_league_id_scoring_run_id_fkey"; columns: ["league_id","scoring_run_id"]; isOneToOne: false; referencedRelation: "scoring_runs"; referencedColumns: ["league_id","id"] }];
  };
  fantasy_scores: {
    Row: {
      league_id: string;
      scoring_run_id: string;
      fantasy_team_id: string;
      points: number;
    };
    Insert: {
      league_id: string;
      scoring_run_id: string;
      fantasy_team_id: string;
      points: number;
    };
    Update: {
      league_id?: string;
      scoring_run_id?: string;
      fantasy_team_id?: string;
      points?: number;
    };
    Relationships: [{ foreignKeyName: "fantasy_scores_league_id_fantasy_team_id_fkey"; columns: ["league_id","fantasy_team_id"]; isOneToOne: false; referencedRelation: "fantasy_teams"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "fantasy_scores_league_id_scoring_run_id_fkey"; columns: ["league_id","scoring_run_id"]; isOneToOne: false; referencedRelation: "scoring_runs"; referencedColumns: ["league_id","id"] }];
  };
  fantasy_squad_players: {
    Row: {
      league_id: string;
      fantasy_team_id: string;
      league_player_id: string;
      acquired_price: number;
    };
    Insert: {
      league_id: string;
      fantasy_team_id: string;
      league_player_id: string;
      acquired_price: number;
    };
    Update: {
      league_id?: string;
      fantasy_team_id?: string;
      league_player_id?: string;
      acquired_price?: number;
    };
    Relationships: [{ foreignKeyName: "fantasy_squad_players_league_id_fantasy_team_id_fkey"; columns: ["league_id","fantasy_team_id"]; isOneToOne: false; referencedRelation: "fantasy_teams"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "fantasy_squad_players_league_id_league_player_id_fkey"; columns: ["league_id","league_player_id"]; isOneToOne: false; referencedRelation: "league_players"; referencedColumns: ["league_id","id"] }];
  };
  fantasy_teams: {
    Row: {
      id: string;
      league_id: string;
      manager_id: string;
      name: string;
      created_at: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      manager_id: string;
      name: string;
      created_at?: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      manager_id?: string;
      name?: string;
      created_at?: string;
    };
    Relationships: [{ foreignKeyName: "fantasy_teams_league_id_manager_id_fkey"; columns: ["league_id","manager_id"]; isOneToOne: true; referencedRelation: "league_members"; referencedColumns: ["league_id","user_id"] }];
  };
  gameweeks: {
    Row: {
      id: string;
      league_id: string;
      season_id: string;
      number: number;
      deadline: string;
      scoring_rule_set_id: string | null;
    };
    Insert: {
      id?: string;
      league_id: string;
      season_id: string;
      number: number;
      deadline: string;
      scoring_rule_set_id?: string | null;
    };
    Update: {
      id?: string;
      league_id?: string;
      season_id?: string;
      number?: number;
      deadline?: string;
      scoring_rule_set_id?: string | null;
    };
    Relationships: [{ foreignKeyName: "gameweek_scoring_version_fk"; columns: ["league_id","scoring_rule_set_id"]; isOneToOne: false; referencedRelation: "scoring_rule_sets"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "gameweeks_league_id_fkey"; columns: ["league_id"]; isOneToOne: false; referencedRelation: "leagues"; referencedColumns: ["id"] }, { foreignKeyName: "gameweeks_league_id_season_id_fkey"; columns: ["league_id","season_id"]; isOneToOne: false; referencedRelation: "seasons"; referencedColumns: ["league_id","id"] }];
  };
  head_to_head_fixtures: {
    Row: {
      id: string;
      league_id: string;
      gameweek_id: string;
      home_team_id: string;
      away_team_id: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      gameweek_id: string;
      home_team_id: string;
      away_team_id: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      gameweek_id?: string;
      home_team_id?: string;
      away_team_id?: string;
    };
    Relationships: [{ foreignKeyName: "head_to_head_fixtures_league_id_away_team_id_fkey"; columns: ["league_id","away_team_id"]; isOneToOne: false; referencedRelation: "fantasy_teams"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "head_to_head_fixtures_league_id_gameweek_id_fkey"; columns: ["league_id","gameweek_id"]; isOneToOne: false; referencedRelation: "gameweeks"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "head_to_head_fixtures_league_id_home_team_id_fkey"; columns: ["league_id","home_team_id"]; isOneToOne: false; referencedRelation: "fantasy_teams"; referencedColumns: ["league_id","id"] }];
  };
  league_members: {
    Row: {
      league_id: string;
      user_id: string;
      role: 'leader' | 'manager';
      status: 'active' | 'inactive';
      joined_at: string;
    };
    Insert: {
      league_id: string;
      user_id: string;
      role: 'leader' | 'manager';
      status?: 'active' | 'inactive';
      joined_at?: string;
    };
    Update: {
      league_id?: string;
      user_id?: string;
      role?: 'leader' | 'manager';
      status?: 'active' | 'inactive';
      joined_at?: string;
    };
    Relationships: [{ foreignKeyName: "league_members_league_id_fkey"; columns: ["league_id"]; isOneToOne: false; referencedRelation: "leagues"; referencedColumns: ["id"] }, { foreignKeyName: "league_members_user_id_fkey"; columns: ["user_id"]; isOneToOne: false; referencedRelation: "profiles"; referencedColumns: ["id"] }];
  };
  league_players: {
    Row: {
      id: string;
      league_id: string;
      player_id: string;
      position: Position;
      price: number;
      rating: number;
      active: boolean;
    };
    Insert: {
      id?: string;
      league_id: string;
      player_id: string;
      position: Position;
      price: number;
      rating: number;
      active?: boolean;
    };
    Update: {
      id?: string;
      league_id?: string;
      player_id?: string;
      position?: Position;
      price?: number;
      rating?: number;
      active?: boolean;
    };
    Relationships: [{ foreignKeyName: "league_players_league_id_player_id_fkey"; columns: ["league_id","player_id"]; isOneToOne: true; referencedRelation: "player_profiles"; referencedColumns: ["league_id","id"] }];
  };
  league_standings: {
    Row: {
      league_id: string;
      season_id: string;
      fantasy_team_id: string;
      mode: 'fantasy_total' | 'head_to_head';
      fantasy_points: number;
      h2h_points: number | null;
      computed_at: string;
    };
    Insert: {
      league_id: string;
      season_id: string;
      fantasy_team_id: string;
      mode: 'fantasy_total' | 'head_to_head';
      fantasy_points: number;
      h2h_points?: number | null;
      computed_at?: string;
    };
    Update: {
      league_id?: string;
      season_id?: string;
      fantasy_team_id?: string;
      mode?: 'fantasy_total' | 'head_to_head';
      fantasy_points?: number;
      h2h_points?: number | null;
      computed_at?: string;
    };
    Relationships: [{ foreignKeyName: "league_standings_league_id_fantasy_team_id_fkey"; columns: ["league_id","fantasy_team_id"]; isOneToOne: false; referencedRelation: "fantasy_teams"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "league_standings_league_id_season_id_fkey"; columns: ["league_id","season_id"]; isOneToOne: false; referencedRelation: "seasons"; referencedColumns: ["league_id","id"] }];
  };
  leagues: {
    Row: {
      id: string;
      name: string;
      budget: number;
      market_open: boolean;
      created_at: string;
      archived_at: string | null;
    };
    Insert: {
      id?: string;
      name: string;
      budget?: number;
      market_open?: boolean;
      created_at?: string;
      archived_at?: string | null;
    };
    Update: {
      id?: string;
      name?: string;
      budget?: number;
      market_open?: boolean;
      created_at?: string;
      archived_at?: string | null;
    };
    Relationships: [];
  };
  match_approvals: {
    Row: {
      id: string;
      league_id: string;
      match_id: string;
      submission_id: string;
      revision_id: string;
      kind: 'lineup' | 'result';
      decision: 'approved' | 'rejected';
      reviewed_by: string;
      reason: string | null;
      reviewed_at: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      match_id: string;
      submission_id: string;
      revision_id: string;
      kind: 'lineup' | 'result';
      decision: 'approved' | 'rejected';
      reviewed_by: string;
      reason?: string | null;
      reviewed_at?: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      match_id?: string;
      submission_id?: string;
      revision_id?: string;
      kind?: 'lineup' | 'result';
      decision?: 'approved' | 'rejected';
      reviewed_by?: string;
      reason?: string | null;
      reviewed_at?: string;
    };
    Relationships: [{ foreignKeyName: "match_approvals_league_id_match_id_submission_id_revision__fkey"; columns: ["league_id","match_id","submission_id","revision_id","kind"]; isOneToOne: false; referencedRelation: "match_submissions"; referencedColumns: ["league_id","match_id","id","revision_id","kind"] }, { foreignKeyName: "match_approvals_league_id_reviewed_by_fkey"; columns: ["league_id","reviewed_by"]; isOneToOne: false; referencedRelation: "league_members"; referencedColumns: ["league_id","user_id"] }];
  };
  match_events: {
    Row: {
      id: string;
      league_id: string;
      revision_id: string;
      player_id: string;
      related_player_id: string | null;
      event_type: string;
      minute: number | null;
      quantity: number;
      details: Json;
    };
    Insert: {
      id?: string;
      league_id: string;
      revision_id: string;
      player_id: string;
      related_player_id?: string | null;
      event_type: string;
      minute?: number | null;
      quantity?: number;
      details?: Json;
    };
    Update: {
      id?: string;
      league_id?: string;
      revision_id?: string;
      player_id?: string;
      related_player_id?: string | null;
      event_type?: string;
      minute?: number | null;
      quantity?: number;
      details?: Json;
    };
    Relationships: [{ foreignKeyName: "match_events_league_id_revision_id_player_id_fkey"; columns: ["league_id","revision_id","player_id"]; isOneToOne: false; referencedRelation: "real_match_lineup_players"; referencedColumns: ["league_id","revision_id","player_id"] }, { foreignKeyName: "match_events_league_id_revision_id_related_player_id_fkey"; columns: ["league_id","revision_id","related_player_id"]; isOneToOne: false; referencedRelation: "real_match_lineup_players"; referencedColumns: ["league_id","revision_id","player_id"] }];
  };
  match_organizers: {
    Row: {
      league_id: string;
      user_id: string;
    };
    Insert: {
      league_id: string;
      user_id: string;
    };
    Update: {
      league_id?: string;
      user_id?: string;
    };
    Relationships: [{ foreignKeyName: "match_organizers_league_id_user_id_fkey"; columns: ["league_id","user_id"]; isOneToOne: true; referencedRelation: "league_members"; referencedColumns: ["league_id","user_id"] }];
  };
  match_player_performances: {
    Row: {
      id: string;
      league_id: string;
      official_result_id: string;
      revision_id: string;
      player_id: string;
      played: boolean;
      actual_position: Position;
    };
    Insert: {
      id?: string;
      league_id: string;
      official_result_id: string;
      revision_id: string;
      player_id: string;
      played: boolean;
      actual_position: Position;
    };
    Update: {
      id?: string;
      league_id?: string;
      official_result_id?: string;
      revision_id?: string;
      player_id?: string;
      played?: boolean;
      actual_position?: Position;
    };
    Relationships: [{ foreignKeyName: "match_player_performances_league_id_official_result_id_rev_fkey"; columns: ["league_id","official_result_id","revision_id"]; isOneToOne: false; referencedRelation: "official_match_results"; referencedColumns: ["league_id","id","revision_id"] }, { foreignKeyName: "match_player_performances_league_id_revision_id_player_id_fkey"; columns: ["league_id","revision_id","player_id"]; isOneToOne: false; referencedRelation: "real_match_lineup_players"; referencedColumns: ["league_id","revision_id","player_id"] }];
  };
  match_revisions: {
    Row: {
      id: string;
      league_id: string;
      match_id: string;
      version: number;
      state: 'draft' | 'submitted' | 'approved' | 'rejected' | 'corrected';
      match_snapshot: Json;
      team_a_score: number | null;
      team_b_score: number | null;
      created_at: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      match_id: string;
      version: number;
      state?: 'draft' | 'submitted' | 'approved' | 'rejected' | 'corrected';
      match_snapshot?: Json;
      team_a_score?: number | null;
      team_b_score?: number | null;
      created_at?: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      match_id?: string;
      version?: number;
      state?: 'draft' | 'submitted' | 'approved' | 'rejected' | 'corrected';
      match_snapshot?: Json;
      team_a_score?: number | null;
      team_b_score?: number | null;
      created_at?: string;
    };
    Relationships: [{ foreignKeyName: "match_revisions_league_id_match_id_fkey"; columns: ["league_id","match_id"]; isOneToOne: false; referencedRelation: "real_matches"; referencedColumns: ["league_id","id"] }];
  };
  match_submissions: {
    Row: {
      id: string;
      league_id: string;
      match_id: string;
      revision_id: string;
      kind: 'lineup' | 'result';
      approved_lineup_approval_id: string | null;
      approved_lineup_decision: string | null;
      approved_lineup_kind: string | null;
      submitted_by: string;
      submitted_at: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      match_id: string;
      revision_id: string;
      kind: 'lineup' | 'result';
      approved_lineup_approval_id?: string | null;
      approved_lineup_decision?: string | null;
      approved_lineup_kind?: string | null;
      submitted_by: string;
      submitted_at?: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      match_id?: string;
      revision_id?: string;
      kind?: 'lineup' | 'result';
      approved_lineup_approval_id?: string | null;
      approved_lineup_decision?: string | null;
      approved_lineup_kind?: string | null;
      submitted_by?: string;
      submitted_at?: string;
    };
    Relationships: [{ foreignKeyName: "match_submissions_league_id_match_id_revision_id_fkey"; columns: ["league_id","match_id","revision_id"]; isOneToOne: false; referencedRelation: "match_revisions"; referencedColumns: ["league_id","match_id","id"] }, { foreignKeyName: "match_submissions_league_id_submitted_by_fkey"; columns: ["league_id","submitted_by"]; isOneToOne: false; referencedRelation: "league_members"; referencedColumns: ["league_id","user_id"] }, { foreignKeyName: "result_requires_approved_lineup"; columns: ["league_id","match_id","approved_lineup_approval_id","approved_lineup_decision","approved_lineup_kind"]; isOneToOne: false; referencedRelation: "match_approvals"; referencedColumns: ["league_id","match_id","id","decision","kind"] }];
  };
  notifications: {
    Row: {
      id: string;
      league_id: string;
      recipient_id: string;
      kind: string;
      payload: Json;
      created_at: string;
      read_at: string | null;
    };
    Insert: {
      id?: string;
      league_id: string;
      recipient_id: string;
      kind: string;
      payload?: Json;
      created_at?: string;
      read_at?: string | null;
    };
    Update: {
      id?: string;
      league_id?: string;
      recipient_id?: string;
      kind?: string;
      payload?: Json;
      created_at?: string;
      read_at?: string | null;
    };
    Relationships: [{ foreignKeyName: "notifications_league_id_recipient_id_fkey"; columns: ["league_id","recipient_id"]; isOneToOne: false; referencedRelation: "league_members"; referencedColumns: ["league_id","user_id"] }];
  };
  official_match_results: {
    Row: {
      id: string;
      league_id: string;
      match_id: string;
      revision_id: string;
      approval_id: string;
      is_current: boolean;
      decision: string;
      kind: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      match_id: string;
      revision_id: string;
      approval_id: string;
      is_current?: boolean;
      decision?: string;
      kind?: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      match_id?: string;
      revision_id?: string;
      approval_id?: string;
      is_current?: boolean;
      decision?: string;
      kind?: string;
    };
    Relationships: [{ foreignKeyName: "official_match_results_league_id_approval_id_revision_id_d_fkey"; columns: ["league_id","approval_id","revision_id","decision","kind"]; isOneToOne: false; referencedRelation: "match_approvals"; referencedColumns: ["league_id","id","revision_id","decision","kind"] }, { foreignKeyName: "official_match_results_league_id_match_id_revision_id_fkey"; columns: ["league_id","match_id","revision_id"]; isOneToOne: false; referencedRelation: "match_revisions"; referencedColumns: ["league_id","match_id","id"] }];
  };
  player_approval_logs: {
    Row: {
      id: string;
      league_id: string;
      suggestion_id: string;
      actor_id: string;
      decision: string;
      reason: string | null;
      created_at: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      suggestion_id: string;
      actor_id: string;
      decision: string;
      reason?: string | null;
      created_at?: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      suggestion_id?: string;
      actor_id?: string;
      decision?: string;
      reason?: string | null;
      created_at?: string;
    };
    Relationships: [{ foreignKeyName: "player_approval_logs_league_id_actor_id_fkey"; columns: ["league_id","actor_id"]; isOneToOne: false; referencedRelation: "league_members"; referencedColumns: ["league_id","user_id"] }, { foreignKeyName: "player_approval_logs_league_id_suggestion_id_fkey"; columns: ["league_id","suggestion_id"]; isOneToOne: true; referencedRelation: "player_suggestions"; referencedColumns: ["league_id","id"] }];
  };
  player_profiles: {
    Row: {
      id: string;
      league_id: string;
      display_name: string;
      image_path: string | null;
      image_url: string | null;
      created_at: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      display_name: string;
      image_path?: string | null;
      image_url?: string | null;
      created_at?: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      display_name?: string;
      image_path?: string | null;
      image_url?: string | null;
      created_at?: string;
    };
    Relationships: [{ foreignKeyName: "player_profiles_league_id_fkey"; columns: ["league_id"]; isOneToOne: false; referencedRelation: "leagues"; referencedColumns: ["id"] }];
  };
  player_suggestions: {
    Row: {
      id: string;
      league_id: string;
      submitted_by: string;
      name: string;
      position: Position;
      image_path: string | null;
      image_url: string | null;
      notes: string | null;
      status: 'pending' | 'approved' | 'rejected';
      league_player_id: string | null;
      created_at: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      submitted_by: string;
      name: string;
      position: Position;
      image_path?: string | null;
      image_url?: string | null;
      notes?: string | null;
      status?: 'pending' | 'approved' | 'rejected';
      league_player_id?: string | null;
      created_at?: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      submitted_by?: string;
      name?: string;
      position?: Position;
      image_path?: string | null;
      image_url?: string | null;
      notes?: string | null;
      status?: 'pending' | 'approved' | 'rejected';
      league_player_id?: string | null;
      created_at?: string;
    };
    Relationships: [{ foreignKeyName: "player_suggestions_league_id_fkey"; columns: ["league_id"]; isOneToOne: false; referencedRelation: "leagues"; referencedColumns: ["id"] }, { foreignKeyName: "player_suggestions_league_id_league_player_id_fkey"; columns: ["league_id","league_player_id"]; isOneToOne: false; referencedRelation: "league_players"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "player_suggestions_league_id_submitted_by_fkey"; columns: ["league_id","submitted_by"]; isOneToOne: false; referencedRelation: "league_members"; referencedColumns: ["league_id","user_id"] }];
  };
  profiles: {
    Row: {
      id: string;
      display_name: string;
      created_at: string;
    };
    Insert: {
      id: string;
      display_name: string;
      created_at?: string;
    };
    Update: {
      id?: string;
      display_name?: string;
      created_at?: string;
    };
    Relationships: [];
  };
  real_football_teams: {
    Row: {
      id: string;
      league_id: string;
      name: string;
      active: boolean;
    };
    Insert: {
      id?: string;
      league_id: string;
      name: string;
      active?: boolean;
    };
    Update: {
      id?: string;
      league_id?: string;
      name?: string;
      active?: boolean;
    };
    Relationships: [{ foreignKeyName: "real_football_teams_league_id_fkey"; columns: ["league_id"]; isOneToOne: false; referencedRelation: "leagues"; referencedColumns: ["id"] }];
  };
  real_match_lineup_players: {
    Row: {
      id: string;
      league_id: string;
      revision_id: string;
      lineup_id: string;
      player_id: string;
      selection: 'starter' | 'substitute';
      actual_position: Position;
      eligibility_kind: 'registered' | 'temporary';
      eligibility_evidence: Json;
    };
    Insert: {
      id?: string;
      league_id: string;
      revision_id: string;
      lineup_id: string;
      player_id: string;
      selection: 'starter' | 'substitute';
      actual_position: Position;
      eligibility_kind: 'registered' | 'temporary';
      eligibility_evidence: Json;
    };
    Update: {
      id?: string;
      league_id?: string;
      revision_id?: string;
      lineup_id?: string;
      player_id?: string;
      selection?: 'starter' | 'substitute';
      actual_position?: Position;
      eligibility_kind?: 'registered' | 'temporary';
      eligibility_evidence?: Json;
    };
    Relationships: [{ foreignKeyName: "real_match_lineup_players_league_id_player_id_fkey"; columns: ["league_id","player_id"]; isOneToOne: false; referencedRelation: "player_profiles"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "real_match_lineup_players_league_id_revision_id_lineup_id_fkey"; columns: ["league_id","revision_id","lineup_id"]; isOneToOne: false; referencedRelation: "real_match_lineups"; referencedColumns: ["league_id","revision_id","id"] }];
  };
  real_match_lineups: {
    Row: {
      id: string;
      league_id: string;
      match_id: string;
      revision_id: string;
      team_id: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      match_id: string;
      revision_id: string;
      team_id: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      match_id?: string;
      revision_id?: string;
      team_id?: string;
    };
    Relationships: [{ foreignKeyName: "real_match_lineups_league_id_match_id_revision_id_fkey"; columns: ["league_id","match_id","revision_id"]; isOneToOne: false; referencedRelation: "match_revisions"; referencedColumns: ["league_id","match_id","id"] }, { foreignKeyName: "real_match_lineups_league_id_team_id_fkey"; columns: ["league_id","team_id"]; isOneToOne: false; referencedRelation: "real_football_teams"; referencedColumns: ["league_id","id"] }];
  };
  real_matches: {
    Row: {
      id: string;
      league_id: string;
      gameweek_id: string;
      team_a_id: string;
      team_b_id: string;
      organizer_id: string;
      starts_at: string;
      venue: string;
      starters_per_side: number;
      max_substitutes: number;
      created_at: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      gameweek_id: string;
      team_a_id: string;
      team_b_id: string;
      organizer_id: string;
      starts_at: string;
      venue: string;
      starters_per_side: number;
      max_substitutes: number;
      created_at?: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      gameweek_id?: string;
      team_a_id?: string;
      team_b_id?: string;
      organizer_id?: string;
      starts_at?: string;
      venue?: string;
      starters_per_side?: number;
      max_substitutes?: number;
      created_at?: string;
    };
    Relationships: [{ foreignKeyName: "real_matches_league_id_gameweek_id_fkey"; columns: ["league_id","gameweek_id"]; isOneToOne: false; referencedRelation: "gameweeks"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "real_matches_league_id_organizer_id_fkey"; columns: ["league_id","organizer_id"]; isOneToOne: false; referencedRelation: "league_members"; referencedColumns: ["league_id","user_id"] }, { foreignKeyName: "real_matches_league_id_team_a_id_fkey"; columns: ["league_id","team_a_id"]; isOneToOne: false; referencedRelation: "real_football_teams"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "real_matches_league_id_team_b_id_fkey"; columns: ["league_id","team_b_id"]; isOneToOne: false; referencedRelation: "real_football_teams"; referencedColumns: ["league_id","id"] }];
  };
  real_team_players: {
    Row: {
      id: string;
      league_id: string;
      team_id: string;
      player_id: string;
      valid_from: string;
      valid_until: string | null;
    };
    Insert: {
      id?: string;
      league_id: string;
      team_id: string;
      player_id: string;
      valid_from: string;
      valid_until?: string | null;
    };
    Update: {
      id?: string;
      league_id?: string;
      team_id?: string;
      player_id?: string;
      valid_from?: string;
      valid_until?: string | null;
    };
    Relationships: [{ foreignKeyName: "real_team_players_league_id_player_id_fkey"; columns: ["league_id","player_id"]; isOneToOne: false; referencedRelation: "player_profiles"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "real_team_players_league_id_team_id_fkey"; columns: ["league_id","team_id"]; isOneToOne: false; referencedRelation: "real_football_teams"; referencedColumns: ["league_id","id"] }];
  };
  scoring_rule_sets: {
    Row: {
      id: string;
      league_id: string;
      version: number;
      state: 'draft' | 'published' | 'retired';
      captain_multiplier: number;
      vice_policy: Json;
      bench_policy: Json;
      published_at: string | null;
    };
    Insert: {
      id?: string;
      league_id: string;
      version: number;
      state: 'draft' | 'published' | 'retired';
      captain_multiplier?: number;
      vice_policy?: Json;
      bench_policy?: Json;
      published_at?: string | null;
    };
    Update: {
      id?: string;
      league_id?: string;
      version?: number;
      state?: 'draft' | 'published' | 'retired';
      captain_multiplier?: number;
      vice_policy?: Json;
      bench_policy?: Json;
      published_at?: string | null;
    };
    Relationships: [{ foreignKeyName: "scoring_rule_sets_league_id_fkey"; columns: ["league_id"]; isOneToOne: false; referencedRelation: "leagues"; referencedColumns: ["id"] }];
  };
  scoring_rule_values: {
    Row: {
      league_id: string;
      rule_set_id: string;
      event_type: string;
      position: Position;
      points: number;
    };
    Insert: {
      league_id: string;
      rule_set_id: string;
      event_type: string;
      position: Position;
      points: number;
    };
    Update: {
      league_id?: string;
      rule_set_id?: string;
      event_type?: string;
      position?: Position;
      points?: number;
    };
    Relationships: [{ foreignKeyName: "scoring_rule_values_league_id_rule_set_id_fkey"; columns: ["league_id","rule_set_id"]; isOneToOne: false; referencedRelation: "scoring_rule_sets"; referencedColumns: ["league_id","id"] }];
  };
  scoring_runs: {
    Row: {
      id: string;
      league_id: string;
      gameweek_id: string;
      rule_set_id: string;
      status: 'pending' | 'complete' | 'superseded' | 'failed';
      input_hash: string;
      created_at: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      gameweek_id: string;
      rule_set_id: string;
      status: 'pending' | 'complete' | 'superseded' | 'failed';
      input_hash: string;
      created_at?: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      gameweek_id?: string;
      rule_set_id?: string;
      status?: 'pending' | 'complete' | 'superseded' | 'failed';
      input_hash?: string;
      created_at?: string;
    };
    Relationships: [{ foreignKeyName: "scoring_runs_league_id_gameweek_id_rule_set_id_fkey"; columns: ["league_id","gameweek_id","rule_set_id"]; isOneToOne: false; referencedRelation: "gameweeks"; referencedColumns: ["league_id","id","scoring_rule_set_id"] }, { foreignKeyName: "scoring_runs_league_id_rule_set_id_fkey"; columns: ["league_id","rule_set_id"]; isOneToOne: false; referencedRelation: "scoring_rule_sets"; referencedColumns: ["league_id","id"] }];
  };
  seasons: {
    Row: {
      id: string;
      league_id: string;
      name: string;
      starts_at: string;
      ends_at: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      name: string;
      starts_at: string;
      ends_at: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      name?: string;
      starts_at?: string;
      ends_at?: string;
    };
    Relationships: [{ foreignKeyName: "seasons_league_id_fkey"; columns: ["league_id"]; isOneToOne: false; referencedRelation: "leagues"; referencedColumns: ["id"] }];
  };
  temporary_participant_authorizations: {
    Row: {
      id: string;
      league_id: string;
      match_id: string;
      team_id: string;
      player_id: string;
      authorized_by: string;
      reason: string;
      created_at: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      match_id: string;
      team_id: string;
      player_id: string;
      authorized_by: string;
      reason: string;
      created_at?: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      match_id?: string;
      team_id?: string;
      player_id?: string;
      authorized_by?: string;
      reason?: string;
      created_at?: string;
    };
    Relationships: [{ foreignKeyName: "temporary_participant_authorizatio_league_id_authorized_by_fkey"; columns: ["league_id","authorized_by"]; isOneToOne: false; referencedRelation: "league_members"; referencedColumns: ["league_id","user_id"] }, { foreignKeyName: "temporary_participant_authorizations_league_id_match_id_fkey"; columns: ["league_id","match_id"]; isOneToOne: false; referencedRelation: "real_matches"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "temporary_participant_authorizations_league_id_player_id_fkey"; columns: ["league_id","player_id"]; isOneToOne: false; referencedRelation: "player_profiles"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "temporary_participant_authorizations_league_id_team_id_fkey"; columns: ["league_id","team_id"]; isOneToOne: false; referencedRelation: "real_football_teams"; referencedColumns: ["league_id","id"] }];
  };
  transfers: {
    Row: {
      id: string;
      league_id: string;
      fantasy_team_id: string;
      gameweek_id: string;
      out_player_id: string | null;
      in_player_id: string;
      out_price: number | null;
      in_price: number;
      created_at: string;
      actor_id: string;
    };
    Insert: {
      id?: string;
      league_id: string;
      fantasy_team_id: string;
      gameweek_id: string;
      out_player_id?: string | null;
      in_player_id: string;
      out_price?: number | null;
      in_price: number;
      created_at?: string;
      actor_id: string;
    };
    Update: {
      id?: string;
      league_id?: string;
      fantasy_team_id?: string;
      gameweek_id?: string;
      out_player_id?: string | null;
      in_player_id?: string;
      out_price?: number | null;
      in_price?: number;
      created_at?: string;
      actor_id?: string;
    };
    Relationships: [{ foreignKeyName: "transfers_league_id_actor_id_fkey"; columns: ["league_id","actor_id"]; isOneToOne: false; referencedRelation: "league_members"; referencedColumns: ["league_id","user_id"] }, { foreignKeyName: "transfers_league_id_fantasy_team_id_fkey"; columns: ["league_id","fantasy_team_id"]; isOneToOne: false; referencedRelation: "fantasy_teams"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "transfers_league_id_gameweek_id_fkey"; columns: ["league_id","gameweek_id"]; isOneToOne: false; referencedRelation: "gameweeks"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "transfers_league_id_in_player_id_fkey"; columns: ["league_id","in_player_id"]; isOneToOne: false; referencedRelation: "league_players"; referencedColumns: ["league_id","id"] }, { foreignKeyName: "transfers_league_id_out_player_id_fkey"; columns: ["league_id","out_player_id"]; isOneToOne: false; referencedRelation: "league_players"; referencedColumns: ["league_id","id"] }];
  };
}; Views: Record<string, never>; Functions: Record<string, never>; Enums: Record<string, never>; CompositeTypes: Record<string, never> } };
