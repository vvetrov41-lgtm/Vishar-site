// What actually differs between the enquiry and the client card.
//
// The old warning said "the contact details submitted with this enquiry differ
// from the current client card" and stopped there. An operator looking at a
// phone number that ends 7507 has no way to tell whether the card is stale or
// the client mistyped, so the sentence was a worry rather than a decision.
//
// This shows the two values side by side, per field, and writes only the
// fields ticked. The enquiry's submitted values are never touched: they are the
// record of what the client actually sent, and the audit trail depends on them
// staying that way.

import { useState } from 'react';
import { useLanguage } from '../lib/i18n';
import { formatPhoneForDisplay } from '../lib/phone';
import type { RecordEditApi } from '../lib/record-edit-api';
import type { Client, Enquiry } from '../lib/types';

type FieldKey = 'fullName' | 'email' | 'phone' | 'instagram' | 'preferredContact' | 'travellingFrom';

interface Field {
  key: FieldKey;
  current: string | null | undefined;
  submitted: string | null | undefined;
  display: (value: string | null | undefined) => string;
}

function same(left: string | null | undefined, right: string | null | undefined) {
  return (left ?? '').trim().toLocaleLowerCase('en-GB') === (right ?? '').trim().toLocaleLowerCase('en-GB');
}

/**
 * The fields where the enquiry and the client card disagree. A submitted value
 * the client left blank is not a difference: an empty form field is silence,
 * not an instruction to delete what the CRM already knows.
 */
export function contactDifferences(
  enquiry: Enquiry,
  client: Client,
  plain: (value: string | null | undefined) => string,
): Field[] {
  const phone = (value: string | null | undefined) => formatPhoneForDisplay(value ?? null) ?? '—';
  const candidates: Field[] = [
    { key: 'fullName', current: client.full_name, submitted: enquiry.submitted_full_name, display: plain },
    { key: 'email', current: client.email, submitted: enquiry.submitted_email, display: plain },
    { key: 'phone', current: client.phone, submitted: enquiry.submitted_phone, display: phone },
    { key: 'instagram', current: client.instagram, submitted: enquiry.submitted_instagram, display: plain },
    { key: 'preferredContact', current: client.preferred_contact, submitted: enquiry.submitted_preferred_contact, display: plain },
    { key: 'travellingFrom', current: client.travelling_from, submitted: enquiry.submitted_travelling_from, display: plain },
  ];
  return candidates.filter(
    (field) => (field.submitted ?? '').trim().length > 0 && !same(field.current, field.submitted)
  );
}

export function EnquiryContactConflict({
  enquiry,
  client,
  api,
  onSaved,
}: {
  enquiry: Enquiry;
  client: Client;
  api: Pick<RecordEditApi, 'updateClientDetails'>;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const plain = (value: string | null | undefined) => (value ?? '').trim() || '—';
  const fields = contactDifferences(enquiry, client, plain);
  const [chosen, setChosen] = useState<FieldKey[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (fields.length === 0) return null;

  const labelFor: Record<FieldKey, string> = {
    fullName: t('enquiry.name'),
    email: t('enquiry.email'),
    phone: t('enquiry.phone'),
    instagram: t('enquiry.instagram'),
    preferredContact: t('enquiry.prefers'),
    travellingFrom: t('enquiry.travellingFrom'),
  };

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      // Everything the card already holds, with only the ticked fields
      // replaced. Sending the whole record is what update_client_details
      // expects; sending it unchanged is what keeps "keep current" honest.
      const pick = (key: FieldKey, submitted: string | null | undefined, current: string | null | undefined) =>
        (chosen.includes(key) ? submitted : current) ?? null;

      await api.updateClientDetails(client.id, {
        fullName: pick('fullName', enquiry.submitted_full_name, client.full_name) ?? client.full_name,
        email: pick('email', enquiry.submitted_email, client.email),
        phone: pick('phone', enquiry.submitted_phone, client.phone),
        instagram: pick('instagram', enquiry.submitted_instagram, client.instagram),
        preferredContact: pick('preferredContact', enquiry.submitted_preferred_contact, client.preferred_contact),
        travellingFrom: pick('travellingFrom', enquiry.submitted_travelling_from, client.travelling_from),
      });
      setChosen([]);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('enquiry.actionFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="notice warn" role="status">
      <p style={{ margin: 0 }}>{t('enquiry.contactDiffersShort')}</p>

      <div className="contact-diff">
        {fields.map((field) => {
          const picked = chosen.includes(field.key);
          return (
            <div key={field.key} className="contact-diff-row">
              <p className="contact-diff-field">{labelFor[field.key]}</p>
              <p className="contact-diff-value">
                <span className="contact-diff-label">{t('enquiry.diffCurrent')}</span>{' '}
                {field.display(field.current)}
              </p>
              <p className="contact-diff-value">
                <span className="contact-diff-label">{t('enquiry.diffSubmitted')}</span>{' '}
                {field.display(field.submitted)}
              </p>
              <label className="contact-diff-choice">
                <input
                  type="checkbox"
                  checked={picked}
                  disabled={busy}
                  onChange={() => setChosen((current) => (
                    picked ? current.filter((key) => key !== field.key) : [...current, field.key]
                  ))}
                />
                <span>{t('enquiry.useEnquiryValue')}</span>
              </label>
            </div>
          );
        })}
      </div>

      {error ? <p className="notice warn" role="alert">{error}</p> : null}

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy || chosen.length === 0}
          onClick={() => { void apply(); }}
        >
          {busy ? t('enquiry.savingContact') : t('enquiry.useEnquiryData')}
        </button>
      </div>
      <p className="meta" style={{ marginBottom: 0 }}>{t('enquiry.submittedUnchanged')}</p>
    </div>
  );
}
