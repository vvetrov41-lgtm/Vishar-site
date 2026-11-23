import { useEffect, useRef } from 'react';

/** Re-read facts edited by a client, another device, or ChatGPT when returning to CRM. */
export function useAppointmentResponseRefresh(reload: () => void, enabled = true) {
  const current = useRef(reload);
  current.current = reload;
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => { if (document.visibilityState === 'visible') current.current(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [enabled]);
}
