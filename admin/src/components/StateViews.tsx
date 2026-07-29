// Loading, empty and error states.
//
// Every list and detail screen uses these, so a screen with nothing on it says
// why rather than looking broken. `role="status"` and `role="alert"` mean a
// screen reader is told about the change too.

import type { ReactNode } from 'react';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      {label}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="state" role="status">
      <h3>{title}</h3>
      {hint ? <p>{hint}</p> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state error" role="alert">
      <h3>Something went wrong</h3>
      <p>{message}</p>
      {onRetry ? (
        <div className="actions" style={{ justifyContent: 'center' }}>
          <button type="button" onClick={onRetry}>Try again</button>
        </div>
      ) : null}
    </div>
  );
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
