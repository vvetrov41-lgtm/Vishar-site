import { useState, type FormEvent } from 'react';
import { useSession } from '../lib/session';

export function LoginPage() {
  const { signIn, error } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await signIn(email, password);
    } catch {
      // The message is already on the session; nothing further to add here.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 420, paddingTop: 48 }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: 4 }}>Vishar CRM</h1>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>Staff sign in.</p>

      <form className="card" onSubmit={onSubmit} noValidate>
        <label htmlFor="email">Email</label>
        <input
          id="email" name="email" type="email" autoComplete="username"
          value={email} onChange={(event) => setEmail(event.target.value)} required
        />

        <div style={{ height: 12 }} />

        <label htmlFor="password">Password</label>
        <input
          id="password" name="password" type="password" autoComplete="current-password"
          value={password} onChange={(event) => setPassword(event.target.value)} required
        />

        {error ? <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p> : null}

        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>

      <p className="notice">
        Accounts are created by the owner. Password resets are handled in Supabase,
        not here.
      </p>
    </div>
  );
}
