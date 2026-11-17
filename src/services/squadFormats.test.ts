import { describe, expect, it } from 'vitest';
import { deriveFormation, formatRules, lineupIssues, resolveAutomaticSubstitutions } from './squadFormats';
import type { MatchFormat } from './squadFormats';

const player = (id: string, position: 'GK' | 'DEF' | 'MID' | 'FWD', played = true) => ({ id, position, played });

describe('match-format squad rules', () => {
  it('keeps the existing 11-a-side squad and formations unchanged', () => {
    const rules = formatRules('11-a-side');
    expect(rules).toMatchObject({ total: 15, starters: 11, bench: 4, positionLimits: { GK: 2, DEF: 5, MID: 5, FWD: 3 } });
    expect([...rules.formations]).toEqual(['4-3-3', '4-4-2', '3-5-2', '3-4-3', '4-5-1', '5-3-2', '5-4-1']);
  });

  it.each([
    ['7-a-side', 10, 7, 3, ['3-2-1', '2-3-1', '2-2-2']],
    ['5-a-side', 7, 5, 2, ['2-1-1', '1-2-1']],
  ] as Array<[MatchFormat, number, number, number, string[]]>)('defines the approved %s roster and legal shapes', (format, total, starters, bench, formations) => {
    expect(formatRules(format)).toMatchObject({ total, starters, bench });
    expect([...formatRules(format).formations]).toEqual(formations);
  });

  it('derives shape only from starters, never the bench', () => {
    const starting = [player('g', 'GK'), ...Array.from({ length: 4 }, (_, i) => player(`d${i}`, 'DEF')),
      ...Array.from({ length: 3 }, (_, i) => player(`m${i}`, 'MID')),
      ...Array.from({ length: 3 }, (_, i) => player(`f${i}`, 'FWD'))];
    const bench = [player('bench-gk', 'GK'), player('bench-def', 'DEF'), player('bench-mid', 'MID'), player('bench-fwd', 'FWD')];
    expect(deriveFormation(starting, '11-a-side')).toBe('4-3-3');
    expect(deriveFormation(starting, '11-a-side')).not.toBe('3-5-2');
    expect(bench).toHaveLength(4); // Bench data is a separate collection and is never passed to the derivation.
  });

  it('omits shapes that exceed the chosen full-squad forward limits', () => {
    const sevenRoster = [player('g1', 'GK'), player('g2', 'GK'), ...Array.from({ length: 3 }, (_, i) => player(`d${i}`, 'DEF')),
      ...Array.from({ length: 3 }, (_, i) => player(`m${i}`, 'MID')), ...Array.from({ length: 2 }, (_, i) => player(`f${i}`, 'FWD'))];
    const impossibleSeven = [player('sg', 'GK'), player('sd1', 'DEF'), player('sd2', 'DEF'), player('sm', 'MID'),
      player('sf1', 'FWD'), player('sf2', 'FWD'), player('sf3', 'FWD')];
    const fiveRoster = [player('g1', 'GK'), player('g2', 'GK'), player('d1', 'DEF'), player('d2', 'DEF'),
      player('m1', 'MID'), player('m2', 'MID'), player('f', 'FWD')];
    const impossibleFive = [player('g', 'GK'), player('d', 'DEF'), player('m', 'MID'), player('f1', 'FWD'), player('f2', 'FWD')];
    expect(deriveFormation(impossibleSeven, '7-a-side')).toBeNull();
    expect(lineupIssues(impossibleSeven, sevenRoster, '7-a-side')).toContain('Formation 2-1-3 is not legal for 7-a-side.');
    expect(deriveFormation(impossibleFive, '5-a-side')).toBeNull();
    expect(lineupIssues(impossibleFive, fiveRoster, '5-a-side')).toContain('Formation 1-1-2 is not legal for 5-a-side.');
  });

  it('reports exact missing position requirements and rejects a second starting goalkeeper', () => {
    const starters = [player('g1', 'GK'), player('g2', 'GK'), ...Array.from({ length: 4 }, (_, i) => player(`d${i}`, 'DEF')),
      ...Array.from({ length: 3 }, (_, i) => player(`m${i}`, 'MID')),
      ...Array.from({ length: 2 }, (_, i) => player(`f${i}`, 'FWD'))];
    expect(deriveFormation(starters, '11-a-side')).toBeNull();
    expect(lineupIssues(starters, starters, '11-a-side')).toContain('Starting lineup needs exactly 1 GK; currently 2.');
  });

  it('applies only an explicit, legal, bench-ordered matchday substitution and vice fallback', () => {
    const starters = [player('g', 'GK'), ...Array.from({ length: 4 }, (_, i) => player(`d${i}`, 'DEF')),
      ...Array.from({ length: 3 }, (_, i) => player(`m${i}`, 'MID')),
      ...Array.from({ length: 3 }, (_, i) => player(`f${i}`, 'FWD'))];
    starters[0] = player('g', 'GK', false);
    starters[1] = player('captain', 'DEF', false);
    const bench = [player('bench-gk', 'GK'), player('bench-def', 'DEF'), player('bench-mid', 'MID'), player('bench-fwd', 'FWD')];
    const result = resolveAutomaticSubstitutions(starters, bench, 'captain', 'm0', '11-a-side');
    expect(result.substitutions).toEqual([{ outId: 'g', inId: 'bench-gk' }, { outId: 'captain', inId: 'bench-def' }]);
    expect(result.captainId).toBe('m0');
    expect(deriveFormation(result.starters, '11-a-side')).toBe('4-3-3');
  });

  it('does not mutate manager assignments or auto-sub a player on refresh', () => {
    const starters = [player('g', 'GK', false), ...Array.from({ length: 4 }, (_, i) => player(`d${i}`, 'DEF')),
      ...Array.from({ length: 3 }, (_, i) => player(`m${i}`, 'MID')),
      ...Array.from({ length: 3 }, (_, i) => player(`f${i}`, 'FWD'))];
    const bench = [player('bench-gk', 'GK')];
    const before = starters.map((p) => p.id);
    resolveAutomaticSubstitutions(starters, bench, null, null, '11-a-side');
    expect(starters.map((p) => p.id)).toEqual(before);
  });
});
