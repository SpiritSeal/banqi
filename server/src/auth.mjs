// Passport-based OAuth (GitHub + Google), an opt-in dev backdoor, and a
// guest-session endpoint so visitors can play without signing up.
// Session id sits in a signed cookie; the user row id is the only thing
// stored in the session.

import passportDefault, { Passport } from 'passport';
import { Strategy as GitHubStrategy } from 'passport-github';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { randomBytes } from 'node:crypto';
import { upsertOAuthUser, getUser } from './db.mjs';
import { makeRateLimiter } from './rate_limit.mjs';

const PgSession = connectPgSimple(session);
// passport's default singleton accumulates strategies + (de)serializers
// across every configureAuth() call. That's harmless for one-shot
// production boots, but in tests (and in any hot-reload scenario) a
// stale deserializer from the previous build can short-circuit the chain
// — `done(null, false)` from a closure pointing at an already-ended pg
// pool stops the cascade before the live deserializer runs, silently
// 401-ing every request. Instantiating a fresh Passport here per
// buildApp() keeps the auth surface tied to the lifetime of its owning
// db pool.
function newPassport() {
  // The constructor lives on the default export as `Passport`. Falling
  // back to the named import keeps this resilient to bundler differences.
  const PassportCtor = Passport || passportDefault.Passport;
  return new PassportCtor();
}

// Same-origin relative path or '/' — rejects protocol-relative ('//evil.com')
// and absolute URLs so a crafted `?next=` can't turn the relay into an open
// redirect after sign-in.
function safeNext(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return null;
  if (value[0] !== '/') return null;
  if (value[1] === '/' || value[1] === '\\') return null;
  return value;
}

function stashNext(req, _res, nextFn) {
  const n = safeNext(req.query.next);
  if (n) req.session.postLoginNext = n;
  nextFn();
}
function popNext(req) {
  const n = req.session?.postLoginNext;
  if (req.session && 'postLoginNext' in req.session) delete req.session.postLoginNext;
  return n || '/';
}

// Coarse per-IP guard for the guest endpoint: 5 new guest sessions per IP per
// hour. Survives process restarts no, intentionally — guests are ephemeral.
// Wraps the shared `makeRateLimiter` in rate_limit.mjs so the in-memory
// sliding-window logic lives in one place.
function makeGuestRateLimiter({ windowMs = 60 * 60 * 1000, max = 5 } = {}) {
  return makeRateLimiter({ windowMs, max });
}

const GUEST_ANIMALS = [
  'Otter', 'Sparrow', 'Cricket', 'Heron', 'Magpie', 'Tortoise',
  'Marten', 'Vixen', 'Falcon', 'Stoat', 'Crane', 'Hare',
];
function newGuestName() {
  const animal = GUEST_ANIMALS[Math.floor(Math.random() * GUEST_ANIMALS.length)];
  return `Guest ${animal} ${Math.floor(1000 + Math.random() * 9000)}`;
}

export function configureAuth(app, { db, serverSecret, publicUrl, env }) {
  // Persist sessions in Postgres. With the default MemoryStore the session
  // record evaporates on every process restart (cold start on Cloud Run, a
  // redeploy, the idle reaper), and every signed-in user gets silently
  // logged out — the cookie is still valid client-side, but passport's
  // deserializeUser sees nothing in the store and req.user becomes
  // undefined. The schema for the `session` table lives in schema.sql so
  // openDb() creates it before this constructor runs.
  const sessionStore = new PgSession({
    pool: db,
    tableName: 'session',
    // We create the table ourselves in schema.sql so the library doesn't
    // need to do its own (separate, non-idempotent) bootstrap query.
    createTableIfMissing: false,
  });
  const sessionParser = session({
    store: sessionStore,
    secret: serverSecret,
    resave: false,
    saveUninitialized: false,
    // rolling: true keeps the cookie's 30-day window sliding on activity,
    // so an actively-used session doesn't quietly age out from underneath
    // someone who plays a couple games a week.
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: publicUrl.startsWith('https://'),
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  });
  app.use(sessionParser);
  const passport = newPassport();
  app.use(passport.initialize());
  app.use(passport.session());

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try {
      const u = await getUser(db, id);
      done(null, u || null);
    } catch (e) {
      // A transient DB error here used to bubble up as a 500 on every
      // single request — sign-in pages, the lobby, the games list. Log it
      // and tell passport "no user right now" instead: the cookie stays
      // valid, the user appears signed out for the duration of the blip,
      // and the next request succeeds once the pool recovers. Re-auth is
      // not required because the session id in the cookie is untouched.
      console.error('deserializeUser: db lookup failed, treating as logged-out:', e);
      done(null, false);
    }
  });

  const adapt = (provider) => async (accessToken, refreshToken, profile, done) => {
    try {
      const user = await upsertOAuthUser(db, {
        provider,
        providerId:  String(profile.id),
        displayName: profile.displayName || profile.username || `user-${profile.id}`,
        avatarUrl:   profile.photos?.[0]?.value || null,
      });
      done(null, user);
    } catch (e) { done(e); }
  };

  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    // `state: true` makes the CSRF state parameter explicit. The underlying
    // passport-oauth2 enables a nonce store when this is set, which uses the
    // session to bind the OAuth callback to the originating browser. Pinning
    // it here documents the security posture and survives a future default
    // flip. Requires the session middleware registered above.
    passport.use(new GitHubStrategy({
      clientID:     env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      callbackURL:  `${publicUrl}/auth/callback/github`,
      state:        true,
    }, adapt('github')));

    app.get('/auth/github', stashNext,
      passport.authenticate('github', { scope: ['read:user'] }));
    app.get('/auth/callback/github',
      passport.authenticate('github', { failureRedirect: '/?auth=fail' }),
      (req, res) => res.redirect(popNext(req)));
  }

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    // `state: true` mirrors the GitHub strategy above; `pkce: true` opts into
    // Google's PKCE flow (best practice even with a confidential client) so
    // the authorization code is bound to the originating browser session.
    passport.use(new GoogleStrategy({
      clientID:     env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      callbackURL:  `${publicUrl}/auth/callback/google`,
      state:        true,
      pkce:         true,
    }, adapt('google')));

    app.get('/auth/google', stashNext,
      passport.authenticate('google', { scope: ['profile'] }));
    app.get('/auth/callback/google',
      passport.authenticate('google', { failureRedirect: '/?auth=fail' }),
      (req, res) => res.redirect(popNext(req)));
  }

  // Guest sessions: create an ephemeral user with provider='guest'. Useful for
  // people clicking an invite link without an account. Excluded from Elo /
  // leaderboard / profile pages.
  const guestLimit = makeGuestRateLimiter();
  app.get('/auth/guest', async (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    if (!guestLimit(String(ip))) {
      return res.status(429).send('Too many guest sessions from this network. Try again later.');
    }
    const target = safeNext(req.query.next) || '/';
    try {
      const providerId = randomBytes(16).toString('hex');
      const user = await upsertOAuthUser(db, {
        provider:    'guest',
        providerId,
        displayName: newGuestName(),
        avatarUrl:   null,
      });
      req.login(user, (err) => {
        if (err) return next(err);
        res.redirect(target);
      });
    } catch (e) { next(e); }
  });

  // Dev backdoor: /auth/dev?name=Alice. Gated behind AUTH_DEV=1 so production
  // deployments can't accidentally enable it.
  if (env.AUTH_DEV === '1') {
    app.get('/auth/dev', async (req, res, next) => {
      const name = String(req.query.name || 'Dev').slice(0, 32);
      const target = safeNext(req.query.next) || '/';
      try {
        const user = await upsertOAuthUser(db, {
          provider:    'dev',
          providerId:  name,
          displayName: name,
          avatarUrl:   null,
        });
        req.login(user, (err) => {
          if (err) return next(err);
          res.redirect(target);
        });
      } catch (e) { next(e); }
    });
  }

  app.post('/auth/logout', (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.json({ ok: true });
    });
  });

  return { sessionParser, passport, sessionStore };
}

export function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  res.status(401).json({ error: 'auth required' });
}

// Tells the client which providers are configured, so the landing page can
// hide buttons we can't actually fulfill. Guest is always available.
export function authProviders(env) {
  return {
    github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    dev:    env.AUTH_DEV === '1',
    guest:  true,
  };
}
