function normalisedDigits(phone: string | null | undefined): string | null {
  let value = (phone ?? '').trim();
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
