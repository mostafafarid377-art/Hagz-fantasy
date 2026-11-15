/**
 * @vitest-environment node
 *
 * Guards the route table itself.
 *
 * The `/profile` bug was NOT in a component: `ModeSwitch`, `useAuth` and the live
 * screens were all correct. The defect was two lines in `main.tsx` that rendered
 * the demo components directly instead of routing through `ModeSwitch`, so a
 * signed-in user got a demo persona on a "Live" session.
 *
 * A component-level test cannot catch that - it exercises `ModeSwitch` and never
 * looks at the route table. This test inspects `main.tsx` as source, which is a
 * blunt instrument but exactly the right one for a wiring regression: it fails if
 * anyone adds a protected route that bypasses the Live/Demo decision.
 *
 * The public/auth routes are intentionally exempt: they are always real screens
 * and must render signed-out.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/main.tsx', 'utf8');

/** Route paths that live inside <AppLayout> and thus need a Live/Demo decision. */
const protectedPaths = [
  '/dashboard', '/league', '/create-league', '/join-league', '/market',
  '/players/:id', '/suggest', '/management', '/approvals', '/squad',
  '/squad-builder', '/transfers', '/fixtures', '/match-center', '/standings',
  '/statistics', '/points', '/profile', '/settings', '/notifications',
];

/** The route's element expression, or null if the path is not declared. */
function elementFor(path: string): string | null {
  // Match: <Route path="/x" element={...}/>  capturing the element expression.
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`<Route\\s+path="${escaped}"\\s+element=\\{(.+?)\\}\\s*/>`));
  return match ? match[1] : null;
}

describe('every protected route goes through the Live/Demo decision', () => {
  for (const path of protectedPaths) {
    it(`${path} is decided by ModeSwitch (or DashboardRoute)`, () => {
      const element = elementFor(path);
      expect(element, `route ${path} is not declared in main.tsx`).not.toBeNull();
      expect(
        /ModeSwitch|DashboardRoute/.test(element!),
        `route ${path} bypasses the Live/Demo decision: ${element}`,
      ).toBe(true);
    });
  }

  it('no protected route renders a raw demo component', () => {
    // The exact regression: <Route path="/profile" element={<Profile/>}/>.
    // A bare `<Profile/>`/`<SettingsPage/>` element has no ModeSwitch around it.
    const offenders = protectedPaths.filter((path) => {
      const element = elementFor(path);
      return element !== null && !/ModeSwitch|DashboardRoute/.test(element);
    });
    expect(offenders).toEqual([]);
  });

  it('/profile and /settings resolve to the live account screens', () => {
    expect(elementFor('/profile')).toMatch(/LiveProfile/);
    expect(elementFor('/settings')).toMatch(/LiveSettings/);
  });
});
