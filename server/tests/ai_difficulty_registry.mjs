// Static consistency checks for the AI difficulty registry.
//
// Regression guard for the Policy-AI 400 bug: the lobby exposed `policy` and
// the AI engine implemented it, but the server's AI_DIFFICULTIES whitelist
// hadn't been updated, so POST /api/games with opponent=ai:policy returned
// 400 and the client silently fell back to local play.
//
// These tests catch the same class of mismatch BEFORE any HTTP request is
// made. They have no runtime deps (no Postgres, no WASM) so they run
// anywhere `node --test` runs.
//
// The end-to-end half of the invariant — every whitelisted difficulty has a
// seeded users row and is accepted by POST /api/games — lives in
// ai_persisted_game.mjs.
//
// Run with: node --test server/tests/ai_difficulty_registry.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { AI_DIFFICULTIES } from '../src/db.mjs';
import { Difficulty } from '../../ai/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

describe('AI difficulty registry stays in sync across UI / engine / server', () => {
  it('every Difficulty constant from the AI engine is in AI_DIFFICULTIES', () => {
    const engineDifficulties = Object.values(Difficulty);
    assert.ok(engineDifficulties.length > 0, 'ai/index.mjs exports no Difficulty values');
    for (const d of engineDifficulties) {
      assert.ok(
        AI_DIFFICULTIES.includes(d),
        `Difficulty '${d}' is exported by ai/index.mjs but missing from server AI_DIFFICULTIES — `
        + `POST /api/games with opponent=ai:${d} will return 400 "unknown AI difficulty"`,
      );
    }
  });

  it('every <option> in the lobby AI difficulty dropdown is in AI_DIFFICULTIES', () => {
    const html = readFileSync(resolve(REPO_ROOT, 'web', 'index.html'), 'utf8');
    // Pull the <select id="lobby-ai-difficulty"> ... </select> block and
    // extract option values from it. A regex is fine here — the HTML is
    // checked in alongside the test, and a malformed match would surface
    // as a missing-difficulty failure, not a silent pass.
    const selectMatch = html.match(
      /<select[^>]*id="lobby-ai-difficulty"[^>]*>([\s\S]*?)<\/select>/);
    assert.ok(selectMatch,
              'could not find <select id="lobby-ai-difficulty"> in web/index.html');
    const optionValues = [...selectMatch[1].matchAll(/<option[^>]*value="([^"]+)"/g)]
      .map((m) => m[1]);
    assert.ok(optionValues.length > 0, 'lobby-ai-difficulty select has no <option>s');
    for (const v of optionValues) {
      assert.ok(
        AI_DIFFICULTIES.includes(v),
        `Lobby dropdown exposes AI difficulty '${v}' but the server whitelist doesn't accept it — `
        + `POST /api/games with opponent=ai:${v} will return 400 and fall back to local play`,
      );
    }
  });
});
