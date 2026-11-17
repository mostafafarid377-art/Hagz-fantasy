# Squad persistence, formats, and matchday substitution policy

## Findings from the current implementation

- The only durable starter/bench ordering is `fantasy_lineup_players.slot`, stored inside a gameweek-specific `fantasy_lineups` row. `ff_squad_buy` marks an unconfirmed draft `superseded`; `ff_squad` then reads only a `draft` or `confirmed` lineup and orders the roster by display name when no slot exists. That discards the authoritative ordering and explains why a bench player can re-enter the XI after refresh.
- The previous client-side `localStorage` order hint is not authoritative, device-independent, or protected by the database. It cannot meet persistence, manager-isolation, or atomicity requirements. The recent formation-balanced fallback also guesses assignments and therefore must be removed for the final design.
- `LiveSquad.selectPlayer` swaps two array entries and calls `ff_lineup_save`. That RPC requires all 15 players, a supplied manual formation, and non-null captain and vice-captain fields. It tests captain eligibility against the full roster, not the Starting XI. Consequently a normal substitution can fail on missing/stale captaincy and there is no single server-side operation to move both assignments atomically.
- The league has no stored match format. New league creation stores only name and budget. Squad purchase, lineup validation, and display all hard-code 15/11 and 2 GK / 5 DEF / 5 MID / 3 FWD. The real-match workflow stores `starters_per_side` per fixture but does not constrain new fixtures to the league's format.
- `fantasy_teams` stores nullable captain IDs. The dedicated RPC allows captaincy choices for any roster player, while full lineup saves merely require the two IDs to exist somewhere in the 15-player list. No substitution rule revalidates that both remain eligible starters.
- The scoring subsystem is deliberately closed: triggers reject writes to performance and score tables, there is no scoring-run RPC/worker, and the points screen only reads scores produced elsewhere. The schema already reserves a fixed captain multiplier of 2, but no approved score values or production path are present. Implementing matchday auto-substitution *in actual scoring* therefore needs a trusted scoring-run integration; this change must not invent values or bypass the closed scoring boundary.

## Recommended small-sided league rules (approved for implementation)

The full-squad distribution below reserves two goalkeepers, and every valid lineup has exactly one goalkeeper. This gives each format a dedicated substitute goalkeeper while preserving meaningful role coverage on small pitches.

| Format | Squad | Starters | Bench | Full squad position limits | Legal outfield DEF-MID-FWD shapes |
|---|---:|---:|---:|---|---|
| 11-a-side | 15 | 11 | 4 | 2 GK, 5 DEF, 5 MID, 3 FWD | 4-3-3, 4-4-2, 3-5-2, 3-4-3, 4-5-1, 5-3-2, 5-4-1 (existing rules) |
| 7-a-side | 10 | 7 | 3 | 2 GK, 3 DEF, 3 MID, 2 FWD | 3-2-1, 2-3-1, 2-2-2 |
| 5-a-side | 7 | 5 | 2 | 2 GK, 2 DEF, 2 MID, 1 FWD | 2-1-1, 1-2-1 |

**Rule clarification:** the requested 7-a-side shape 2-1-3 cannot fit a maximum of two forwards in the 10-player squad; the 5-a-side shape 1-1-2 cannot fit its maximum of one forward. The user chose to preserve the exact squad position limits and remove those two impossible shapes. Every remaining 7-a-side shape has six outfield players, at least two defenders, and at least one midfielder and forward. Every remaining 5-a-side shape has four outfield players and at least one player in each outfield position. Budgets remain league-scoped; existing leagues keep their current 100M budget and are treated as 11-a-side.

## Approved matchday auto-substitution proposal

- The manager's confirmed Starting XI and ordered bench are frozen for the relevant gameweek. Merely refreshing, editing, or changing tabs never runs a matchday substitution.
- Only after an official result is approved and a trusted scoring run is invoked may an unplayed starter be replaced. The resolver processes missing starters in saved starter order and bench players in saved bench order, accepting only a replacement that leaves a legal lineup. A GK vacancy can only be filled by a GK.
- Matchday substitutions affect a match-scoped scoring lineup, not the manager's persistent squad assignment. The vice-captain inherits the captain multiplier only when the captain is ineligible and the vice-captain is eligible; otherwise there is no captain multiplier.
- No position-point values are introduced or changed by this policy.

The approved behavior can be specified and tested as a pure resolver, but it cannot change production points until a trusted scoring-run path exists. The scoring/write boundary will not be weakened to force it through.

## Persistence implementation direction

Add league-scoped server-side squad assignment rows (stable league-player IDs, explicit starter/bench state, starter slot and bench order) independent of gameweek lineups. Migrate recoverable assignments from the latest existing lineup rows. If a legacy roster has no recoverable assignments, do not infer from names, purchase order, or formation: show all players in an explicit unassigned/editor state and require the manager to assign them. An atomic manager-only RPC will validate the exact roster, format, duplicate IDs, captaincy, and assignments; apply substitutions idempotently; derive the formation from starter positions; update any current gameweek snapshot; reload `ff_squad`; and compare the persisted result before returning success. League format is immutable after creation and defaults to 11-a-side for existing records.
