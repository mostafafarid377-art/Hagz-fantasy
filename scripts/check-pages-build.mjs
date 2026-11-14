import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const inputBase = process.env.VITE_BASE_PATH || '/Hagz-fantasy/';
const base = inputBase === '/' ? '/' : `/${inputBase.replace(/^\/+|\/+$/g, '')}/`;
const html = readFileSync('dist/index.html', 'utf8');
const script = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
const stylesheet = html.match(/<link[^>]+href="([^"]+\.css)"/)?.[1];
assert.ok(script?.startsWith(`${base}assets/`), 'Built JavaScript must use the deployment base path');
assert.ok(stylesheet?.startsWith(`${base}assets/`), 'Built stylesheet must use the deployment base path');
assert.ok(!html.includes('/src/main.tsx'), 'Production HTML must not reference Vite source files');
for (const url of [script, stylesheet]) {
  assert.ok(existsSync(resolve('dist', url.slice(base.length))), `Missing build asset: ${url}`);
}
const css = readFileSync(resolve('dist', stylesheet.slice(base.length)), 'utf8');
assert.ok(css.includes(`${base}football-hero.png`), 'Hero image must use the deployment base path');
assert.ok(existsSync('dist/football-hero.png'), 'Hero image must be included in the build');
console.log(`Pages build assets verified for ${base}`);
