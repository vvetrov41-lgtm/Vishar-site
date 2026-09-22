// A standing reminder for an owner account without a second factor. The owner
// holds every client, payment and integration, so a password alone is the
// single weakest point of the whole CRM.

import { useLanguage } from '../lib/i18n';
import { mfaCopy } from '../lib/mfa-copy';
import { ACCOUNT_PATH } from '../lib/account-api';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';

export function OwnerTwoFactorBanner() {
  const { profile, mfa, mfaEnrolled } = useSession();
  const { language } = useLanguage();
  if (!mfa || profile?.role !== 'owner' || mfaEnrolled !== false) return null;
  const copy = mfaCopy(language);
  return (
    <p className="notice warn" role="status">
      {copy.banner} <Link to={ACCOUNT_PATH}>{copy.bannerLink}</Link>
    </p>
  );
}
