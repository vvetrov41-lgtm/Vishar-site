// The database write remains the source of truth. Wake only after successful
// RPC responses, from the exact production CRM and DB; never delay or retry a
// mutation because this optional network hint fails.
const DB = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const CRM = 'https://crm.vishartattoo.com';
const WAKE = 'https://outbox-wake.vishartattoo.com/internal/outbox/wake';
const RPCS = new Set([
  'schedule_appointment','schedule_appointment_with_price','reschedule_appointment',
  'set_appointment_status','set_appointment_price','schedule_session','set_session_status',
  'update_project_deposit','confirm_project_deposit_manually','record_manual_payment',
  'record_invoice_payment','record_session_receipt','record_consultation_booked_outcome'
]);
export function createBookingWakeFetch(projectOrigin: string, pageOrigin: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): typeof fetch {
  if (projectOrigin !== DB || pageOrigin !== CRM) return fetchImpl;
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.ok) return response;
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const match = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
      const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization');
      if (url.origin === DB && method.toUpperCase() === 'POST' && match && RPCS.has(match[1]) && authorization?.startsWith('Bearer ')) {
        void fetchImpl(WAKE, {method:'POST',headers:{authorization},redirect:'error',keepalive:true}).catch(()=>{});
      }
    } catch { /* The committed CRM mutation stays successful. */ }
    return response;
  };
}
