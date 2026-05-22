// Smoke test for the passport-github migration (issue #74). Asserts that
// the named `Strategy` export resolves to a constructable function with the
// expected `.name === 'github'` after instantiation. This is the property
// passport.use() keys off; if the import shape is wrong (e.g. accidentally
// importing the module namespace as the constructor), `new GitHubStrategy(...)`
// would either throw or set name to undefined and registration would silently
// break.
//
// Runs without DATABASE_URL — purely a module-import / constructor check.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Strategy as GitHubStrategy } from 'passport-github';

describe('passport-github named export', () => {
  it('exposes Strategy as a constructor', () => {
    assert.equal(typeof GitHubStrategy, 'function');
  });

  it('constructs a strategy with name === "github"', () => {
    const strat = new GitHubStrategy(
      {
        clientID:     'test-client-id',
        clientSecret: 'test-client-secret',
        callbackURL:  'https://example.test/auth/callback/github',
        state:        true,
      },
      // verify callback — never invoked in this smoke test
      (_accessToken, _refreshToken, _profile, done) => done(null, false),
    );
    assert.equal(strat.name, 'github');
    // Confirm the verify-callback wiring at least stored a function — guards
    // against a future signature change that would drop the verify arg.
    assert.equal(typeof strat._verify, 'function');
  });
});
