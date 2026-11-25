const URL='https://outbox-wake.vishartattoo.com/internal/outbox/wake';
const RPCS=new Set([
  'gpt_schedule_appointment','gpt_schedule_appointment_with_price','gpt_reschedule_appointment',
  'gpt_cancel_appointment','gpt_set_appointment_status','gpt_set_appointment_price',
  'gpt_schedule_project_session','gpt_set_project_session_status','gpt_update_project_deposit',
  'gpt_confirm_project_deposit_manually','gpt_record_manual_payment','gpt_record_invoice_payment',
  'gpt_record_session_receipt','gpt_record_consultation_booked_outcome'
]);
export function wakeAfterBookingRpc(rpc,token,env,ctx,fetchImpl=fetch){
  if(!RPCS.has(rpc)||env?.VISHAR_ENVIRONMENT!=='production'
    ||env?.SUPABASE_URL!=='https://vfjexhfdbrjmuxfdvbdx.supabase.co'
    ||typeof ctx?.waitUntil!=='function'||typeof token!=='string'||!token)return;
  ctx.waitUntil(Promise.resolve().then(()=>fetchImpl(URL,{method:'POST',headers:{authorization:`Bearer ${token}`},redirect:'manual'}))
    .then(response=>{if(!response.ok)console.warn('booking wake unavailable');})
    .catch(()=>console.warn('booking wake unavailable')));
}
