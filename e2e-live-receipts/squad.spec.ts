import { test, expect } from '@playwright/test';

test('Live market buy stays guarded across reload and explicitly retries the same receipt', async ({ page }) => {
  const actor = '10000000-0000-4000-8000-000000000001';
  const league = '20000000-0000-4000-8000-000000000001';
  const player = '30000000-0000-4000-8000-000000000001';
  const jwt = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: actor, role: 'authenticated', exp: 4102444800 })).toString('base64url')}.fixture`;
  const session = { access_token: jwt, refresh_token: 'fixture', expires_in: 3600, expires_at: 4102444800, token_type: 'bearer',
    user: { id: actor, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test', user_metadata: {} } };
  await page.addInitScript(value => localStorage.setItem('sb-example-auth-token', JSON.stringify(value)), session);
  const calls: Array<Record<string, any>> = [];
  let receipt: { kind: string; payload: Record<string, unknown>; state: string } | undefined;
  let lost = false;
  const memberLeague = { league_id: league, name: 'Fixture League', role: 'leader', status: 'active', budget: 100000000,
    market_open: true, archived: false, is_leader: true, is_organizer: false };
  const marketPlayer = { id: player, name: 'Fixture Player', position: 'GK', rating: 70, price: 1000000, active: true, image_url: null };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'example.supabase.co') {
      const name = url.pathname.split('/').pop();
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers, body: '' });
      if (name === 'ff_bootstrap') return route.fulfill({ headers, json: { profile: { id: actor, display_name: 'Fixture' }, leagues: [memberLeague] } });
      if (name === 'ff_market_players') return route.fulfill({ headers, json: [marketPlayer] });
      if (name === 'ff_squad') return route.fulfill({ headers, json: { team: { id: 'team', name: 'team' }, players: receipt?.state === 'committed' ? [{ ...marketPlayer, league_player_id: player, slot: null }] : [], formation: null, status: 'empty', spent: 0, budget: 100000000 } });
      if (name === 'ff_operation_for_actor') {
        const args = route.request().postDataJSON(); calls.push(args);
        expect(args.p_actor).toBe(actor);
        if (args.p_action === 'register') {
          if (!receipt) receipt = { kind: args.p_kind, payload: args.p_payload, state: 'pending' };
          if (!lost) { lost = true; return route.abort('failed'); }
          return route.fulfill({ headers, json: { state: receipt.state } });
        }
        if (args.p_action === 'execute') { receipt!.state = 'committed'; return route.fulfill({ headers, json: { state: 'committed', result: { league_player_id: player } } }); }
        if (args.p_action === 'status') return route.fulfill({ headers, json: { state: receipt?.state ?? 'unknown' } });
      }
      return route.fulfill({ headers, json: [] });
    }
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return route.abort();
    return route.continue();
  });
  await page.goto('/market');
  const add = page.getByRole('button', { name: 'Add to squad' });
  await expect(add).toBeEnabled(); await add.click();
  await expect(page.getByRole('button', { name: 'Retry same operation' })).toBeVisible();
  await expect(add).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry same operation' })).toBeVisible();
  await page.getByRole('button', { name: 'Check operation' }).click();
  await expect(page.getByRole('button', { name: 'Retry same operation' })).toBeVisible();
  expect(calls.filter(c => c.p_action === 'execute')).toHaveLength(0);
  await page.getByRole('button', { name: 'Retry same operation' }).click();
  await expect(page.getByText('Your squad was refreshed. Review it and select players again to retry.')).toBeVisible();
  const regs = calls.filter(c => c.p_action === 'register');
  expect(regs).toHaveLength(2); expect(regs[0]).toEqual(regs[1]);
  expect(regs[0].p_kind).toBe('squad_buy'); expect(regs[0].p_payload).toEqual({ league, player });
  expect(calls.filter(c => c.p_action === 'execute')).toHaveLength(1);
});
