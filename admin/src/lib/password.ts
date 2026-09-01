// One password rule, stated once.
//
// The invitation flow already required 12 to 128 characters, enforced in
// PasswordSetupPage and again in `completePasswordSetup`. Public signup has to
// ask the same question, and a second copy of the rule is how the two answers
// start to differ. So the rule lives here and both callers read it.
//
// Length only, deliberately. Composition rules (an upper case, a digit, a
// symbol) push people towards `Password1!` and are not what Supabase Auth
// checks either; a long passphrase is the thing worth asking for. Supabase's
// own leaked-password protection, when the project enables it, is the check
// that catches the passwords length cannot.

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordProblem = 'length' | 'mismatch';

/** Null when the pair is acceptable. `confirmation` may be omitted where the
 *  screen asks for the password once. */
export function passwordProblem(
  password: string,
  confirmation?: string,
): PasswordProblem | null {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return 'length';
  }
  if (confirmation !== undefined && password !== confirmation) return 'mismatch';
  return null;
}
