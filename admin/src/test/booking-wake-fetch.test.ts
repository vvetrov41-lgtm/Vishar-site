import {describe,expect,it,vi} from 'vitest';
import {createBookingWakeFetch} from '../lib/booking-wake-fetch';
const db='https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const crm='https://crm.vishartattoo.com';
describe('booking wake fetch',()=>{
 it('wakes only after a committed allowlisted production RPC',async()=>{
  const calls=vi.fn(async()=>new Response('{}',{status:200}));
  const f=createBookingWakeFetch(db,crm,calls);
  await f(db+'/rest/v1/rpc/schedule_appointment',{method:'POST',headers:{authorization:'Bearer test'}});
  expect(calls).toHaveBeenCalledTimes(2);
  expect(calls.mock.calls[1][0]).toBe('https://outbox-wake.vishartattoo.com/internal/outbox/wake');
  await f(db+'/rest/v1/rpc/list_appointments',{method:'POST',headers:{authorization:'Bearer test'}});
  expect(calls).toHaveBeenCalledTimes(3);
 });
 it('does not wake on failed writes or non-production origins',async()=>{
  const calls=vi.fn(async()=>new Response('{}',{status:400}));
  await createBookingWakeFetch(db,crm,calls)(db+'/rest/v1/rpc/schedule_appointment',{method:'POST',headers:{authorization:'Bearer test'}});
  expect(calls).toHaveBeenCalledTimes(1);
  const staging=vi.fn(async()=>new Response('{}',{status:200}));
  await createBookingWakeFetch(db,'https://preview.example.test',staging)(db+'/rest/v1/rpc/schedule_appointment',{method:'POST',headers:{authorization:'Bearer test'}});
  expect(staging).toHaveBeenCalledTimes(1);
 });
});
