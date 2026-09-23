// Two-factor authentication (TOTP) for CRM accounts.
//
// Supabase Auth owns the factors and the assurance level; this module is the
// narrow boundary the CRM uses to read and change them. The database enforces
// the result (crm_private.caller_mfa_satisfied): once an account has a
// verified factor, an aal1 session reads nothing until the code is entered.
// This file only has to make that reachable and recoverable from the browser.

export interface MfaFactor {
  id: string;
  friendly_name?: string | null;
  status: string;
  created_at?: string | null;
}

export interface MfaEnrollment {
  factorId: string;
  qrCode: string;
  secret: string;
}

export interface MfaAuth {
  getAuthenticatorAssuranceLevel: () => Promise<{
    data: { currentLevel: string | null; nextLevel: string | null } | null;
    error: unknown;
  }>;
  listFactors: () => Promise<{ data: { totp?: MfaFactor[] } | null; error: unknown }>;
  enroll: (params: { factorType: 'totp'; friendlyName?: string; issuer?: string }) => Promise<{
    data: { id: string; totp: { qr_code: string; secret: string; uri: string } } | null;
    error: unknown;
  }>;
  challengeAndVerify: (params: { factorId: string; code: string }) => Promise<{ data: unknown; error: unknown }>;
  unenroll: (params: { factorId: string }) => Promise<{ data: unknown; error: unknown }>;
}

export const MFA_ISSUER = 'Vishar CRM';
const CODE_RE = /^\d{6}$/;

export function normaliseCode(input: string): string | null {
  const code = input.replace(/\s+/g, '');
  return CODE_RE.test(code) ? code : null;
}

export function hasMfa(auth: { mfa?: MfaAuth } | null | undefined): auth is { mfa: MfaAuth } {
  const mfa = auth?.mfa;
  return Boolean(mfa && typeof mfa.getAuthenticatorAssuranceLevel === 'function'
    && typeof mfa.listFactors === 'function');
}

/** True when this session must present a second factor before the CRM opens. */
export async function needsChallenge(mfa: MfaAuth): Promise<boolean> {
  const result = await mfa.getAuthenticatorAssuranceLevel();
  if (result.error || !result.data) return false;
  return result.data.nextLevel === 'aal2' && result.data.currentLevel !== 'aal2';
}

export async function verifiedFactors(mfa: MfaAuth): Promise<MfaFactor[]> {
  const result = await mfa.listFactors();
  if (result.error) throw new Error('two_factor_unavailable');
  return (result.data?.totp ?? []).filter((factor) => factor.status === 'verified');
}

/**
 * Verifies a code against the account's verified factors. An account may keep
 * a second authenticator as a backup; the code is tried against each until
 * one accepts it, so the person never has to know which device is which.
 */
export async function verifyCode(mfa: MfaAuth, input: string): Promise<void> {
  const code = normaliseCode(input);
  if (!code) throw new Error('invalid_code_format');
  const factors = await verifiedFactors(mfa);
  if (factors.length === 0) throw new Error('two_factor_unavailable');
  for (const factor of factors) {
    const result = await mfa.challengeAndVerify({ factorId: factor.id, code });
    if (!result.error) return;
  }
  throw new Error('invalid_code');
}

export async function startEnrollment(mfa: MfaAuth, friendlyName: string): Promise<MfaEnrollment> {
  // An abandoned enrollment leaves an unverified factor behind; Supabase
  // refuses a second one with the same name, so stale ones are cleared first.
  const listed = await mfa.listFactors();
  for (const factor of listed.data?.totp ?? []) {
    if (factor.status !== 'verified') await mfa.unenroll({ factorId: factor.id });
  }
  const result = await mfa.enroll({ factorType: 'totp', friendlyName, issuer: MFA_ISSUER });
  if (result.error || !result.data) throw new Error('enroll_failed');
  return { factorId: result.data.id, qrCode: result.data.totp.qr_code, secret: result.data.totp.secret };
}

export async function confirmEnrollment(mfa: MfaAuth, factorId: string, input: string): Promise<void> {
  const code = normaliseCode(input);
  if (!code) throw new Error('invalid_code_format');
  const result = await mfa.challengeAndVerify({ factorId, code });
  if (result.error) throw new Error('invalid_code');
}

export async function removeFactor(mfa: MfaAuth, factorId: string): Promise<void> {
  // Supabase requires an aal2 session to remove a verified factor, so a stolen
  // password alone cannot switch two-factor off.
  const result = await mfa.unenroll({ factorId });
  if (result.error) throw new Error('remove_failed');
}
