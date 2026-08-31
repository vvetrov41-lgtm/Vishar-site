import { useState } from 'react';
import { can } from '../lib/permissions';
import type { RecordEditApi } from '../lib/record-edit-api';
import { useRouter } from '../lib/router';
import type { Client, CrmRole } from '../lib/types';

function value(value: string | null | undefined) {
  return value ?? '';
}

export function ClientEditPanel({
  client,
  role,
  api,
  language,
  onSaved,
}: {
  client: Client;
  role: CrmRole | null | undefined;
  api: Pick<RecordEditApi, 'updateClientDetails' | 'archiveClient'>;
  language: 'en' | 'ru';
  onSaved: () => void;
}) {
  const { navigate } = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullName, setFullName] = useState(client.full_name);
  const [email, setEmail] = useState(value(client.email));
  const [phone, setPhone] = useState(value(client.phone));
  const [instagram, setInstagram] = useState(value(client.instagram));
  const [preferredContact, setPreferredContact] = useState(value(client.preferred_contact));
  const [travellingFrom, setTravellingFrom] = useState(value(client.travelling_from));

  if (!can(role, 'editClient')) return null;

  const copy = language === 'ru' ? {
    edit: 'Редактировать клиента',
    delete: 'Удалить клиента',
    save: 'Сохранить',
    cancel: 'Отмена',
    name: 'Имя',
    email: 'Электронная почта',
    phone: 'Телефон / WhatsApp',
    instagram: 'Instagram',
    preferred: 'Предпочитает',
    travelling: 'Откуда приезжает',
    none: 'Не указано',
    failed: 'Не удалось сохранить изменения клиента.',
    deleteFailed: 'Не удалось удалить клиента.',
  } : {
    edit: 'Edit client',
    delete: 'Delete client',
    save: 'Save',
    cancel: 'Cancel',
    name: 'Name',
    email: 'Email',
    phone: 'Phone / WhatsApp',
    instagram: 'Instagram',
    preferred: 'Prefers',
    travelling: 'Travelling from',
    none: 'Not specified',
    failed: 'Could not save the client changes.',
    deleteFailed: 'Could not delete the client.',
  };

  async function archive() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.archiveClient(client.id);
      if (result) navigate('/clients');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.deleteFailed);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <>
        {error ? <div className="notice warn" role="alert" style={{ marginTop: 12 }}>{error}</div> : null}
        <div className="actions" style={{ marginTop: 12 }}>
          <button type="button" disabled={busy} onClick={() => setEditing(true)}>{copy.edit}</button>
          {role === 'owner' ? (
            <button type="button" className="danger" disabled={busy} onClick={() => { void archive(); }}>
              {copy.delete}
            </button>
          ) : null}
        </div>
      </>
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updateClientDetails(client.id, {
        fullName,
        email,
        phone,
        instagram,
        preferredContact,
        travellingFrom,
      });
      setEditing(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      {error ? <div className="notice warn" role="alert">{error}</div> : null}
      <div className="form-grid">
        <label>
          {copy.name}
          <input value={fullName} maxLength={160} onChange={(event) => setFullName(event.target.value)} />
        </label>
        <label>
          {copy.email}
          <input type="email" value={email} maxLength={320} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          {copy.phone}
          <input value={phone} maxLength={80} onChange={(event) => setPhone(event.target.value)} />
        </label>
        <label>
          {copy.instagram}
          <input value={instagram} maxLength={80} onChange={(event) => setInstagram(event.target.value)} />
        </label>
        <label>
          {copy.preferred}
          <select value={preferredContact} onChange={(event) => setPreferredContact(event.target.value)}>
            <option value="">{copy.none}</option>
            <option value="Email">{copy.email}</option>
            <option value="WhatsApp">WhatsApp</option>
            <option value="Instagram">Instagram</option>
          </select>
        </label>
        <label>
          {copy.travelling}
          <input value={travellingFrom} maxLength={160} onChange={(event) => setTravellingFrom(event.target.value)} />
        </label>
      </div>
      <div className="actions">
        <button type="button" className="primary" disabled={busy || fullName.trim().length === 0} onClick={() => { void save(); }}>
          {copy.save}
        </button>
        <button type="button" disabled={busy} onClick={() => { setError(null); setEditing(false); }}>
          {copy.cancel}
        </button>
      </div>
    </div>
  );
}
