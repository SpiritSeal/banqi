// Passport-based OAuth (GitHub + Google), an opt-in dev backdoor, and a
// guest-session endpoint so visitors can play without signing up.
// Session id sits in a signed cookie; the user row id is the only thing
// stored in the session.

import passport from 'passport';
import GitHubStrategy from 'passport-github2';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import session from 'express-session';
import { randomBytes } from 'node:crypto';
import { upsertOAuthUser, getUser } from './db.mjs';
import { makeRateLimiter } from './rate_limit.mjs';

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
  const sessionParser = session({
    secret: serverSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: publicUrl.startsWith('https://'),
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  });
  app.use(sessionParser);
  app.use(passport.initialize());
  app.use(passport.session());

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try {
      const u = await getUser(db, id);
      done(null, u || null);
    } catch (e) { done(e); }
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
    // `state: true` makes the CSRF state parameter explicit. Modern
    // passport-github2 enables it by default, but pinning it here documents
    // the security posture and survives a future default flip. Requires the
    // session middleware registered above (where it stashes the nonce).
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

  return { sessionParser, passport };
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
