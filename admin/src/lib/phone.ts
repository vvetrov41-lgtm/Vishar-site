// Zero-width and bidi control characters that ride along when a number is
// pasted from a phone's contact card. Same set as the database's
// crm_private.strip_invisible_format(): a formatting fix, never a guess.
const INVISIBLE_FORMAT = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

function stripInvisible(phone: string | null | undefined): string {
  return (phone ?? '').replace(INVISIBLE_FORMAT, '');
}

function normalisedDigits(phone: string | null | undefined): string | null {
  let value = stripInvisible(phone).trim();
  if (!value) return null;

  value = value.replace('(0)', '');
  if (!/^\+?[-0-9 ()./]+$/.test(value) || /[()]/.test(value)) return null;

  let digits = value.replace(/[^0-9]/g, '');
  if (value.startsWith('+')) {
    // Already international.
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (/^07[0-9]{9}$/.test(digits)) {
    // The public booking form is UK-facing, so a UK mobile entered in the
    // familiar local form can be converted without guessing a foreign code.
    digits = `44${digits.slice(1)}`;
  } else {
    return null;
  }

  return /^[1-9][0-9]{6,14}$/.test(digits) ? digits : null;
}

export function whatsappDigits(phone: string | null | undefined): string | null {
  return normalisedDigits(phone);
}

// A UK national number in local notation: 0 then a geographic (01/02/03) or
// mobile (07) number. Mirrors crm_private.normalize_local_phone for GB.
const UK_LOCAL = /^0[1-37][0-9]{9}$/;

/**
 * Whether two stored or submitted phones name the same number.
 *
 * Formatting, spaces, invisible characters, `00` vs `+` and the UK `0` vs `+44`
 * forms are not differences. The comparison uses the same normalisation the
 * rest of the CRM uses (normalisedDigits, which mirrors public.normalize_phone
 * plus the UK-mobile local rule). A UK landline in local form is treated as
 * `+44` only when the other side is itself a `+44` number, so the other value
 * supplies the country evidence; a local number is never assigned a country on
 * its own. Two values that cannot be normalised are compared digit for digit.
 */
export function samePhone(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftRaw = stripInvisible(left).trim();
  const rightRaw = stripInvisible(right).trim();
  if (!leftRaw && !rightRaw) return true;
  if (!leftRaw || !rightRaw) return false;

  const leftE164 = normalisedDigits(leftRaw);
  const rightE164 = normalisedDigits(rightRaw);
  if (leftE164 && rightE164) return leftE164 === rightE164;

  const leftDigits = leftRaw.replace(/[^0-9]/g, '');
  const rightDigits = rightRaw.replace(/[^0-9]/g, '');
  const ukLocalMatches = (international: string | null, localDigits: string) =>
    international !== null
    && international.startsWith('44')
    && UK_LOCAL.test(localDigits)
    && international === `44${localDigits.slice(1)}`;
  if (ukLocalMatches(leftE164, rightDigits) || ukLocalMatches(rightE164, leftDigits)) return true;
  if (leftE164 || rightE164) return false;

  return leftDigits.length > 0 && leftDigits === rightDigits;
}

export function formatPhoneForDisplay(phone: string | null | undefined): string | null {
  const digits = normalisedDigits(phone);
  if (!digits) return (phone ?? '').trim() || null;

  if (/^44[0-9]{10}$/.test(digits)) {
    return `+44 ${digits.slice(2, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }

  return `+${digits}`;
}

/**
 * Digit forms a stored phone number might plausibly take, for a search term.
 *
 * Numbers reach the CRM from a booking form, a WhatsApp profile and manual
 * entry, so the same person can be stored as `+447700900123`, `07700900123` or
 * `447700900123`. A search matches on any of them rather than requiring the
 * operator to guess which one was saved. This is a display-layer convenience:
 * it does not normalise or rewrite anything that is stored.
 */
export function phoneSearchCandidates(term: string): string[] {
  const raw = (term ?? '').trim();
  if (!raw) return [];

  const digits = raw.replace(/[^0-9]/g, '');
  // Two digits match far too much to be a useful phone search.
  if (digits.length < 3) return [];

  const candidates = new Set<string>([digits]);

  const international = normalisedDigits(raw);
  if (international) {
    candidates.add(international);
    // The same subscriber number without its country code, for records saved
    // in the local form.
    if (international.startsWith('44') && international.length > 4) {
      candidates.add(`0${international.slice(2)}`);
      candidates.add(international.slice(2));
    }
  }

  if (digits.startsWith('0') && digits.length > 1) candidates.add(digits.slice(1));

  return [...candidates];
}
