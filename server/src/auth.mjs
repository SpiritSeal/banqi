// Passport-based OAuth (GitHub + Google) plus an opt-in dev backdoor for
// local testing. Session id sits in a signed cookie; the user row id is the
// only thing stored in the session.

import passport from 'passport';
import GitHubStrategy from 'passport-github2';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import session from 'express-session';
import { upsertOAuthUser, getUser } from './db.mjs';

export function configureAuth(app, { db, serverSecret, publicUrl, env }) {
  const sessionParser = session({
    secret: serverSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // secure cookies require HTTPS. In production the relay should sit
      // behind a TLS terminator (Cloud Run, Caddy, ...).
      secure: publicUrl.startsWith('https://'),
      maxAge: 30 * 24 * 60 * 60 * 1000,    // 30 days
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
    passport.use(new GitHubStrategy({
      clientID:     env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      callbackURL:  `${publicUrl}/auth/callback/github`,
    }, adapt('github')));

    app.get('/auth/github',
      passport.authenticate('github', { scope: ['read:user'] }));
    app.get('/auth/callback/github',
      passport.authenticate('github', { failureRedirect: '/?auth=fail' }),
      (_req, res) => res.redirect('/'));
  }

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
      clientID:     env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      callbackURL:  `${publicUrl}/auth/callback/google`,
    }, adapt('google')));

    app.get('/auth/google',
      passport.authenticate('google', { scope: ['profile'] }));
    app.get('/auth/callback/google',
      passport.authenticate('google', { failureRedirect: '/?auth=fail' }),
      (_req, res) => res.redirect('/'));
  }

  // Dev backdoor: /auth/dev?name=Alice creates or logs in a user with
  // provider='dev'. Gated behind AUTH_DEV=1 so production deployments can't
  // accidentally enable it.
  if (env.AUTH_DEV === '1') {
    app.get('/auth/dev', async (req, res, next) => {
      const name = String(req.query.name || 'Dev').slice(0, 32);
      try {
        const user = await upsertOAuthUser(db, {
          provider:    'dev',
          providerId:  name,
          displayName: name,
          avatarUrl:   null,
        });
        req.login(user, (err) => {
          if (err) return next(err);
          res.redirect('/');
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
// hide buttons we can't actually fulfill.
export function authProviders(env) {
  return {
    github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    dev:    env.AUTH_DEV === '1',
  };
}
