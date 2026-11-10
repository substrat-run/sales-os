import type { DevPersona } from '@substrat-run/dev-issuer';

/**
 * The local dev cast — the ONE place the issuer and this vertical agree on who exists.
 * `pnpm dev` starts `@substrat-run/dev-issuer` pointed at this file: a real OpenID Connect
 * provider whose only shortcut is that `/authorize` lists names instead of asking for a
 * password. Nothing here is a bypass: the issuer asserts a subject and the identity
 * directory maps it to a principal, the same two steps a deployed instance performs.
 */
export const PERSONAS: DevPersona[] = [
  { sub: 'dev|markus', name: 'Markus', email: 'markus@substrat.test', note: 'sales-admin' },
  { sub: 'dev|martin', name: 'Martin', email: 'martin@substrat.test', note: 'sales-admin' },
  { sub: 'dev|nora', name: 'Nora', email: 'nora@substrat.test', note: 'sales-member' },
  // The other workspace, so the cross-tenant beat has someone to be turned away as.
  { sub: 'dev|rex', name: 'Rex', email: 'rex@rival.test', note: 'admin at a DIFFERENT workspace' },
];

/** The identity pool these logins belong to. */
export const DEV_PROVIDER = 'oidc:dev-issuer';
