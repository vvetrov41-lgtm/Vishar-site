import { useEffect } from 'react';

/** Client action happens outside CRM. Re-read on return, without notifications. */
export function useAppointmentResponseRefresh(reload: () => void) {
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reload]);
}
