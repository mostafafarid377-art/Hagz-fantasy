import type { Position } from '../types/api';

export type MatchFormat = '11-a-side' | '7-a-side' | '5-a-side';
export type OutfieldShape = `${number}-${number}-${number}`;

export interface FormatRules {
  total: number;
  starters: number;
  bench: number;
  positionLimits: Record<Position, number>;
  formations: ReadonlySet<OutfieldShape>;
  minimums: Record<Position, number>;
}

const rules: Record<MatchFormat, FormatRules> = {
  '11-a-side': {
    total: 15, starters: 11, bench: 4,
    positionLimits: { GK: 2, DEF: 5, MID: 5, FWD: 3 },
    formations: new Set(['4-3-3', '4-4-2', '3-5-2', '3-4-3', '4-5-1', '5-3-2', '5-4-1']),
    minimums: { GK: 1, DEF: 3, MID: 3, FWD: 1 },
  },
  '7-a-side': {
    total: 10, starters: 7, bench: 3,
    positionLimits: { GK: 2, DEF: 3, MID: 3, FWD: 2 },
    formations: new Set(['3-2-1', '2-3-1', '2-2-2']),
    minimums: { GK: 1, DEF: 2, MID: 1, FWD: 1 },
  },
  '5-a-side': {
    total: 7, starters: 5, bench: 2,
    positionLimits: { GK: 2, DEF: 2, MID: 2, FWD: 1 },
    formations: new Set(['2-1-1', '1-2-1']),
    minimums: { GK: 1, DEF: 1, MID: 1, FWD: 1 },
  },
};

export const matchFormats = Object.keys(rules) as MatchFormat[];
export const formatRules = (format: MatchFormat | string | null | undefined): FormatRules =>
  rules[(format as MatchFormat)] ?? rules['11-a-side'];

export function countPositions(players: ReadonlyArray<{ position: Position }>): Record<Position, number> {
  return players.reduce((counts, player) => {
    counts[player.position] += 1;
    return counts;
  }, { GK: 0, DEF: 0, MID: 0, FWD: 0 });
}

/** Formation is derived only from the supplied Starting XI, never from the bench. */
export function deriveFormation(
  starters: ReadonlyArray<{ position: Position }>,
  format: MatchFormat | string | null | undefined,
): OutfieldShape | null {
  const counts = countPositions(starters);
  const shape = `${counts.DEF}-${counts.MID}-${counts.FWD}` as OutfieldShape;
  const spec = formatRules(format);
  return starters.length === spec.starters && counts.GK === 1 && spec.formations.has(shape) ? shape : null;
}

export function lineupIssues(
  starters: ReadonlyArray<{ position: Position }>,
  roster: ReadonlyArray<{ position: Position }>,
  format: MatchFormat | string | null | undefined,
): string[] {
  const spec = formatRules(format);
  const starterCounts = countPositions(starters);
  const rosterCounts = countPositions(roster);
  const issues: string[] = [];
  if (roster.length !== spec.total) issues.push(`Squad needs ${spec.total} players; currently ${roster.length}.`);
  if (starters.length !== spec.starters) issues.push(`Starting lineup needs ${spec.starters} players; currently ${starters.length}.`);
  if (roster.length === spec.total) {
    for (const position of ['GK', 'DEF', 'MID', 'FWD'] as const) {
      if (rosterCounts[position] !== spec.positionLimits[position]) {
        issues.push(`Squad needs ${spec.positionLimits[position]} ${position}; currently ${rosterCounts[position]}.`);
      }
    }
  }
  for (const position of ['GK', 'DEF', 'MID', 'FWD'] as const) {
    if (starterCounts[position] < spec.minimums[position]) {
      issues.push(`Starting lineup needs at least ${spec.minimums[position]} ${position}; currently ${starterCounts[position]}.`);
    }
  }
  if (starters.length === spec.starters && starterCounts.GK !== 1) {
    issues.push(`Starting lineup needs exactly 1 GK; currently ${starterCounts.GK}.`);
  }
  if (starters.length === spec.starters && !deriveFormation(starters, format)) {
    const actual = `${starterCounts.DEF}-${starterCounts.MID}-${starterCounts.FWD}`;
    issues.push(`Formation ${actual} is not legal for ${format ?? '11-a-side'}.`);
  }
  return issues;
}

/** Resolve manager-approved matchday auto-subs without mutating squad assignments. */
export function resolveAutomaticSubstitutions<T extends { id: string; position: Position; played: boolean }>(
  starters: readonly T[],
  bench: readonly T[],
  captainId: string | null,
  viceCaptainId: string | null,
  format: MatchFormat | string | null | undefined,
): { starters: T[]; substitutions: Array<{ outId: string; inId: string }>; captainId: string | null } {
  const selected = [...starters];
  const substitutions: Array<{ outId: string; inId: string }> = [];
  const benchPool = [...bench];
  const legal = (candidate: T[]) => deriveFormation(candidate, format) !== null;

  for (const starter of [...selected]) {
    if (starter.played) continue;
    const currentIndex = selected.findIndex((player) => player.id === starter.id);
    if (currentIndex < 0) continue;
    const replacementIndex = benchPool.findIndex((candidate) => {
      if (!candidate.played) return false;
      if (starter.position === 'GK' && candidate.position !== 'GK') return false;
      const next = [...selected];
      next[currentIndex] = candidate;
      return legal(next);
    });
    if (replacementIndex < 0) continue;
    const [replacement] = benchPool.splice(replacementIndex, 1);
    selected[currentIndex] = replacement;
    substitutions.push({ outId: starter.id, inId: replacement.id });
  }

  const eligibleCaptain = selected.some((player) => player.id === captainId && player.played);
  const eligibleVice = selected.some((player) => player.id === viceCaptainId && player.played);
  return {
    starters: selected,
    substitutions,
    captainId: eligibleCaptain ? captainId : eligibleVice ? viceCaptainId : null,
  };
}
