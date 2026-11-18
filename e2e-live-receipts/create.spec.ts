import { test, expect } from '@playwright/test';

test('Live create recovers a lost registration after reload with the same durable envelope', async ({ page }) => {
  const actor = '10000000-0000-4000-8000-000000000001';
  const leagueId = '20000000-0000-4000-8000-000000000001';
  const user = { id: actor, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test', user_metadata: {} };
  const jwt = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: actor, role: 'authenticated', exp: 4102444800 })).toString('base64url')}.fixture`;
  const session = { access_token: jwt, refresh_token: 'fixture', expires_in: 3600, expires_at: 4102444800, token_type: 'bearer', user };
  await page.addInitScript((value) => localStorage.setItem('sb-example-auth-token', JSON.stringify(value)), session);
  const calls: Array<Record<string, any>> = [];
  let row: { kind: string; payload: Record<string, unknown>; state: string; result?: unknown } | undefined;
  let lost = false;
  const league = { league_id: leagueId, name: 'Browser League', role: 'leader', status: 'active', budget: 100000000,
    market_open: true, archived: false, is_leader: true, is_organizer: false };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'example.supabase.co') {
      const name = url.pathname.split('/').pop();
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers, body: '' });
      if (name === 'ff_bootstrap') return route.fulfill({ headers, json: { profile: { id: actor, display_name: 'Fixture' }, leagues: row?.state === 'committed' ? [league] : [] } });
      if (name === 'ff_operation_for_actor') {
        const args = route.request().postDataJSON(); calls.push(args);
        expect(args.p_actor).toBe(actor);
        if (args.p_action === 'register') {
          if (!row) row = { kind: args.p_kind, payload: args.p_payload, state: 'pending' };
          if (!lost) { lost = true; return route.abort('failed'); }
          return route.fulfill({ headers, json: { state: row.state } });
        }
        if (args.p_action === 'execute') { row!.state = 'committed'; row!.result = { id: leagueId, code: 'FIXTURE' }; return route.fulfill({ headers, json: { state: 'committed', result: row!.result } }); }
        if (args.p_action === 'status') return route.fulfill({ headers, json: row?.state === 'committed' ? { state: 'committed', result: row.result } : { state: row?.state ?? 'unknown' } });
        if (args.p_action === 'cancel') { row!.state = 'cancelled'; return route.fulfill({ headers, json: { state: 'cancelled' } }); }
      }
      return route.fulfill({ headers, json: [] });
    }
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return route.abort();
    return route.continue();
  });
  await page.goto('/create-league');
  const submit = page.getByRole('button', { name: 'Create league', exact: true });
  await page.getByLabel('League name').fill('Browser League');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole('button', { name: 'Retry same operation' })).toBeVisible();
  await expect(submit).toBeDisabled();
  expect(calls.map(c => c.p_action)).toEqual(['register']);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry same operation' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry same operation' }).click();
  await expect(page).toHaveURL(/\/league$/);
  const registered = calls.filter(c => c.p_action === 'register');
  expect(registered).toHaveLength(2);
  expect(registered[0]).toEqual(registered[1]);
  expect(registered[0].p_payload).toEqual({ name: 'Browser League', budget: 100000000 });
  expect(calls.filter(c => c.p_action === 'execute')).toHaveLength(1);
});
