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

// A national number in local notation: one trunk-prefix 0, then the national
// significant number. The database converts such a number only with explicit
// country evidence (crm_private.normalize_local_phone); for a comparison the
// other value's country code is that evidence.
const LOCAL_TRUNK = /^0[1-9][0-9]{6,11}$/;

function sameNationalNumber(international: string | null, localDigits: string): boolean {
  if (!international || !LOCAL_TRUNK.test(localDigits)) return false;
  const national = localDigits.slice(1);
  const countryCodeLength = international.length - national.length;
  return countryCodeLength >= 1 && countryCodeLength <= 3 && international.endsWith(national);
}

/**
 * Whether two stored or submitted phones name the same number.
 *
 * Formatting, spaces, invisible characters, `00` vs `+` and the local `0`
 * trunk prefix vs the country code (`07…` / `+447…`, `02…` / `+612…`) are not
 * differences. The comparison uses the same normalisation the rest of the CRM
 * uses (normalisedDigits, which mirrors public.normalize_phone plus the
 * UK-mobile local rule). A local number is never assigned a country on its
 * own: it matches only an international number whose national part is the
 * same digits. Two values that cannot be normalised are compared digit for
 * digit.
 */
export function samePhone(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftRaw = stripInvisible(left).trim();
  const rightRaw = stripInvisible(right).trim();
  if (!leftRaw && !rightRaw) return true;
  if (!leftRaw || !rightRaw) return false;
  // Identical text is never a conflict, even when it is not a number ("N/A").
  if (leftRaw.toLocaleLowerCase('en-GB') === rightRaw.toLocaleLowerCase('en-GB')) return true;

  const leftE164 = normalisedDigits(leftRaw);
  const rightE164 = normalisedDigits(rightRaw);
  if (leftE164 && rightE164) return leftE164 === rightE164;

  const leftDigits = leftRaw.replace(/[^0-9]/g, '');
  const rightDigits = rightRaw.replace(/[^0-9]/g, '');
  if (sameNationalNumber(leftE164, rightDigits) || sameNationalNumber(rightE164, leftDigits)) return true;
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
