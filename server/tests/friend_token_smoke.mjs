// Unit tests for friend-invite tokens (server/src/friend_tokens.mjs).
//
// These exercise the HMAC functions directly — no DB or network — so they
// run standalone without DATABASE_URL.
//
// Run with:  node --test tests/friend_token_smoke.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  friendInviteToken, verifyFriendInviteToken, parseCombinedToken,
} from '../src/friend_tokens.mjs';

const SECRET = 'test-server-secret-do-not-use-in-prod';
const USER_ID = 42;

describe('friendInviteToken', () => {
  it('produces a 32-hex-char (128-bit) token', () => {
    const token = friendInviteToken(SECRET, USER_ID);
    assert.equal(token.length, 32, 'token should be 32 hex chars (128 bits)');
    assert.match(token, /^[0-9a-f]{32}$/, 'token should be lowercase hex');
  });

  it('is deterministic for a given (secret, userId)', () => {
    assert.equal(
      friendInviteToken(SECRET, USER_ID),
      friendInviteToken(SECRET, USER_ID),
    );
  });

  it('differs across userIds with the same secret', () => {
    assert.notEqual(
      friendInviteToken(SECRET, USER_ID),
      friendInviteToken(SECRET, USER_ID + 1),
    );
  });
});

describe('verifyFriendInviteToken', () => {
  it('accepts the matching 32-hex token', () => {
    const token = friendInviteToken(SECRET, USER_ID);
    assert.equal(verifyFriendInviteToken(SECRET, USER_ID, token), true);
  });

  it('rejects a 16-char (old-style 64-bit) token', () => {
    const oldToken = friendInviteToken(SECRET, USER_ID).slice(0, 16);
    assert.equal(oldToken.length, 16);
    assert.equal(verifyFriendInviteToken(SECRET, USER_ID, oldToken), false);
  });

  it('rejects a 64-char (over-long) token', () => {
    const longToken = friendInviteToken(SECRET, USER_ID)
      + friendInviteToken(SECRET, USER_ID);
    assert.equal(longToken.length, 64);
    assert.equal(verifyFriendInviteToken(SECRET, USER_ID, longToken), false);
  });

  it('rejects a non-hex token of the right length', () => {
    const nonHex = 'z'.repeat(32);
    assert.equal(verifyFriendInviteToken(SECRET, USER_ID, nonHex), false);
  });

  it('rejects a token for a different userId', () => {
    const token = friendInviteToken(SECRET, USER_ID);
    assert.equal(verifyFriendInviteToken(SECRET, USER_ID + 1, token), false);
  });

  it('rejects a token signed with a different secret', () => {
    const token = friendInviteToken('other-secret', USER_ID);
    assert.equal(verifyFriendInviteToken(SECRET, USER_ID, token), false);
  });

  it('rejects non-string inputs', () => {
    assert.equal(verifyFriendInviteToken(SECRET, USER_ID, null), false);
    assert.equal(verifyFriendInviteToken(SECRET, USER_ID, undefined), false);
    assert.equal(verifyFriendInviteToken(SECRET, USER_ID, 12345), false);
  });
});

describe('parseCombinedToken', () => {
  it('parses "<userId>-<32hex>" correctly', () => {
    const token = friendInviteToken(SECRET, USER_ID);
    const parsed = parseCombinedToken(`${USER_ID}-${token}`);
    assert.deepEqual(parsed, { userId: USER_ID, token });
  });

  it('rejects "<userId>-<16hex>" (old short form)', () => {
    const token = friendInviteToken(SECRET, USER_ID).slice(0, 16);
    assert.equal(parseCombinedToken(`${USER_ID}-${token}`), null);
  });

  it('rejects malformed input (missing dash, bad chars, etc.)', () => {
    assert.equal(parseCombinedToken(''), null);
    assert.equal(parseCombinedToken('not-a-token'), null);
    assert.equal(parseCombinedToken(`${USER_ID}-${'g'.repeat(32)}`), null);
    assert.equal(parseCombinedToken(null), null);
    assert.equal(parseCombinedToken(undefined), null);
  });

  it('round-trips through verifyFriendInviteToken', () => {
    const token = friendInviteToken(SECRET, USER_ID);
    const combined = `${USER_ID}-${token}`;
    const parsed = parseCombinedToken(combined);
    assert.ok(parsed);
    assert.equal(
      verifyFriendInviteToken(SECRET, parsed.userId, parsed.token),
      true,
    );
  });
});
