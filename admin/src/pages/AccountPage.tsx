// The person, not the business.
//
// The CRM had no screen for the account itself. Name, address, what the
// interface calls you and how to leave were spread between a popover with a
// sign-out button and nowhere at all - and "delete my account" existed only as
// something to ask somebody for.
//
// The boundary this screen keeps: everything here belongs to one person. The
// studio's name, its time zone and its currency belong to the organization and
// are edited where the organization is, because two people in one studio share
// those and share none of these.
//
// Deletion is deliberately slow. The button opens a panel that says what will
// happen in plain words, and the confirmation is the account's own email
// address typed out - which is also what the server checks, so a stray call
// with the wrong idea of who it is deletes nothing.

import { useEffect, useState, type FormEvent } from 'react';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { useLanguage } from '../lib/i18n';
import { useSession } from '../lib/session';
import type { UserFacingRole } from '../lib/account-api';

const ROLE_HINTS: Record<UserFacingRole, string | null> = {
  operator: 'account.roleOperator',
  artist: 'account.roleArtist',
  booking_manager: 'account.roleBookingManager',
  read_only: 'account.roleReadOnly',
  none: null,
};

export function AccountPage() {
  const { account, profile, api, refresh, signOut } = useSession();
  const { t } = useLanguage();

  const [name, setName] = useState(profile?.display_name ?? '');
  const [nameState, setNameState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [nameError, setNameError] = useState<string | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [deleteState, setDeleteState] = useState<'idle' | 'deleting' | 'done'>('idle');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    setName(profile?.display_name ?? '');
  }, [profile?.display_name]);

  if (deleteState === 'done') {
    return (
      <EmptyState title={t('account.deletedTitle')} hint={t('account.deletedHint')} />
    );
  }

  if (!profile) return <LoadingState />;
  if (!account) return <ErrorState message={t('account.unavailable')} />;

  const roleHintKey = ROLE_HINTS[account.user_role];
  const blockedMessage = account.delete_blocked_reason === 'installation_owner'
    ? t('account.blockedOwner')
    : account.delete_blocked_reason === 'shared_tenant'
      ? t('account.blockedShared')
      : null;
  const confirmationMatches =
    confirmation.trim().toLowerCase() === account.email.trim().toLowerCase();

  async function saveName(event: FormEvent) {
    event.preventDefault();
    if (!api) return;
    const next = name.trim();
    setNameError(null);
    if (!next) {
      setNameError(t('account.nameRequired'));
      return;
    }
    setNameState('saving');
    try {
      await api.setMyDisplayName(next);
      await refresh();
      setNameState('saved');
    } catch (cause) {
      setNameState('idle');
      setNameError(cause instanceof Error ? cause.message : t('account.unavailable'));
    }
  }

  async function deleteAccount(event: FormEvent) {
    event.preventDefault();
    if (!api) return;
    setDeleteError(null);
    setDeleteState('deleting');
    try {
      await api.deleteMyAccount(confirmation.trim());
      // The identity is gone server-side; ending the browser session is what
      // makes the screen agree with it.
      setDeleteState('done');
      await signOut();
    } catch (cause) {
      setDeleteState('idle');
      setDeleteError(cause instanceof Error ? cause.message : t('account.unavailable'));
    }
  }

  return (
    <div className="account-page">
      <h2>{t('account.title')}</h2>
      <p className="account-intro">{t('account.intro')}</p>

      <section className="card" aria-labelledby="account-identity">
        <h3 id="account-identity">{t('account.identityTitle')}</h3>

        <form onSubmit={saveName} className="account-field">
          <label htmlFor="account-name">{t('account.name')}</label>
          <input
            id="account-name"
            type="text"
            value={name}
            maxLength={120}
            onChange={(event) => {
              setName(event.target.value);
              setNameState('idle');
            }}
          />
          <small>{t('account.nameHint')}</small>
          <div className="actions">
            <button type="submit" disabled={nameState === 'saving'}>
              {nameState === 'saving' ? t('account.saving') : t('account.save')}
            </button>
            {nameState === 'saved' ? (
              <span className="account-note" role="status">{t('account.saved')}</span>
            ) : null}
          </div>
          {nameError ? <p className="notice warn" role="alert">{nameError}</p> : null}
        </form>

        <div className="account-field">
          <span className="account-label">{t('account.email')}</span>
          <strong className="account-value">{account.email}</strong>
          <small>{t('account.emailHint')}</small>
        </div>

        <div className="account-field">
          <span className="account-label">{t('account.role')}</span>
          <strong className="account-value">{t(`userRole.${account.user_role}`)}</strong>
          {roleHintKey ? <small>{t(roleHintKey)}</small> : null}
        </div>
      </section>

      <section className="card" aria-labelledby="account-language">
        <h3 id="account-language">{t('account.languageTitle')}</h3>
        <LanguageSwitcher />
        <small>{t('account.languageHint')}</small>
      </section>

      <section className="card account-danger" aria-labelledby="account-danger">
        <h3 id="account-danger">{t('account.dangerTitle')}</h3>
        <p>
          {account.is_self_service_founder
            ? t('account.deleteTenantWhat')
            : t('account.deleteMembershipWhat')}
        </p>
        <p>{t('account.deleteKeeps')}</p>
        <p>{t('account.deleteIrreversible')}</p>

        {blockedMessage ? (
          <p className="notice warn" role="status">{blockedMessage}</p>
        ) : confirming ? (
          <form onSubmit={deleteAccount} className="account-field">
            <label htmlFor="account-confirm">
              {t('account.confirmLabel', { email: account.email })}
            </label>
            <input
              id="account-confirm"
              type="text"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
            <small>{t('account.confirmHint')}</small>
            {confirmation.trim() !== '' && !confirmationMatches ? (
              <p className="notice warn" role="status">{t('account.confirmMismatch')}</p>
            ) : null}
            <div className="actions">
              <button
                type="submit"
                className="danger"
                disabled={!confirmationMatches || deleteState === 'deleting'}
              >
                {deleteState === 'deleting' ? t('account.deleting') : t('account.deleteConfirm')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  setConfirmation('');
                  setDeleteError(null);
                }}
              >
                {t('account.deleteCancel')}
              </button>
            </div>
            {deleteError ? <p className="notice warn" role="alert">{deleteError}</p> : null}
          </form>
        ) : (
          <div className="actions">
            <button type="button" className="danger" onClick={() => setConfirming(true)}>
              {t('account.deleteStart')}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
