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
