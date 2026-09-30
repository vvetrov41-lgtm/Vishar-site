// "Book a session" as one closed card.
//
// Open, the booking form is a full phone screen of selects and duration
// buttons. On the project and client pages it used to sit open above the
// sessions already booked, so the first thing an operator scrolled past was a
// form they did not need. Closed, it is one line with a chevron; the heading
// stays a heading so the section is still findable by name.

import type { ReactNode } from 'react';
import { useLanguage } from '../lib/i18n';

export function BookingDisclosure({
  id,
  defaultOpen = false,
  children,
}: {
  id?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const { t } = useLanguage();
  return (
    <details id={id} className="card booking-card-disclosure" open={defaultOpen || undefined}>
      <summary>
        <h2>{t('booking.title')}</h2>
      </summary>
      <div style={{ marginTop: 12 }}>{children}</div>
    </details>
  );
}
