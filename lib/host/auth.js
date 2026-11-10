import { BoardError } from '../core/errors.js';

const WEB_AUTHORITY = Symbol('ProjectBoard web authority');

/**
 * The board route is not behind the /api browser-trust fence, so it carries its
 * own process token. The token is injected into the served index as
 * globalThis.__PROJECT_BOARD__.token; a cross-site page cannot read it.
 */
export function authFailure(req, token) {
  // Diagnose source rejection first: reloading a capability cannot fix it.
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return 'fetch-site-rejected';
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      if (new URL(origin).host !== req.headers.host) return 'origin-rejected';
    } catch {
      return 'origin-rejected';
    }
  }
  const supplied = req.headers['x-project-board-token'];
  if (typeof token !== 'string' || token.length === 0 || typeof supplied !== 'string' || supplied.length !== token.length) return 'token-mismatch';
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= supplied.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0 ? null : 'token-mismatch';
}

export function checkAuth(req, token) {
  return authFailure(req, token) === null;
}

/** Issue the in-process web capability only after the request passes authentication. */
export function authorizeWebRequest(req, token) {
  const denial = authFailure(req, token);
  return denial ? { denial } : { authority: WEB_AUTHORITY };
}

/** Project the trusted capability to the actor recorded by core. */
export function requireWebActor(authority) {
  if (authority !== WEB_AUTHORITY) {
    throw new BoardError('forbidden-role', 'authenticated web authority is required', { status: 403 });
  }
  return { kind: 'human', via: 'web' };
}
