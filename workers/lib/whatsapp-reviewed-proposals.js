// Create and inspect new WhatsApp Utility templates only. This module never
// sends client messages and never mutates the existing active templates.
import { resolveProviderBinding } from './provider-routing.js';
import { createSupabaseClient } from './supabase.js';
import { GRAPH_API_VERSION } from './whatsapp.js';

const ID = /^[0-9]{5,32}$/;
const NAME = /^[a-z0-9_]{1,512}$/;
const KINDS = Object.freeze({
  booking_tattoo: 'booking_card_tattoo_v2',
  booking_tattoo_cash: 'booking_card_tattoo_cash_v3',
  booking_consultation: 'booking_card_consultation_v2',
  booking_consultation_directions: 'booking_card_consultation_v3',
  booking_video: 'booking_card_video_consultation_v2',
  reminder_72h: 'vishar_lifecycle_reminder_72h_v3',
  reminder_72h_button: 'vishar_lifecycle_reminder_72h_v4',
  reminder_24h: 'vishar_lifecycle_reminder_24h_v3',
  reminder_consultation: 'vishar_lifecycle_consultation_v4',
  reminder_24h_button: 'vishar_lifecycle_reminder_24h_v4',
  reminder_consultation_button: 'vishar_lifecycle_consultation_v5',
  reminder_consultation_directions: 'vishar_lifecycle_consultation_v6',
  reminder_consultation_video: 'vishar_lifecycle_consultation_video_v1',
});
const ARTIST_DOMAINS = Object.freeze({
  'a1111111-1111-4111-8111-111111111111': 'vishartattoo.com',
  'a2222222-2222-4222-8222-222222222222': 'www.kristinavishar.com',
});

// Correct consultation venue is a separate Meta-approved static URL. Never
// replace the private tattoo-session arrival guide or edit an approved template.
const YORK_HOUSE_MAP = 'https://maps.app.goo.gl/zfTRAJ4MXEHcHf3S6?g_st=ic';
const VLADIMIR_ID = 'a1111111-1111-4111-8111-111111111111';
const NEW_CONSULTATION_KINDS = new Set([
  'booking_consultation_directions','reminder_consultation_directions',
]);

function definition(target) {
  const domain = ARTIST_DOMAINS[target?.artist_id];
  const name = KINDS[target?.kind];
  const url = target?.arrival_guide_url;
  const faq = target?.preparation_guide_url;
  if (!domain || !name || target?.template_name !== name
      || target?.template_language !== 'en_GB'
      || typeof url !== 'string' || typeof faq !== 'string'
      || !new RegExp('^https://' + domain.replace(/\./g, '\\.') + '/arrival/[0-9a-f]{32}/$').test(url)
      || faq !== 'https://' + domain + '/faq/') {
    throw new Error('Invalid reviewed WhatsApp identity or link');
  }
  if (target.kind === 'booking_tattoo_cash' && target.artist_id !== VLADIMIR_ID) {
    throw new Error('Cash-preference tattoo card is only configured for Vladimir');
  }
  if (NEW_CONSULTATION_KINDS.has(target.kind)
      && target.artist_id !== VLADIMIR_ID) {
    throw new Error('Consultation-map template is not approved for this artist');
  }
  let text, example, buttons=[];
  if (target.kind === 'booking_tattoo' || target.kind === 'booking_tattoo_cash') {
    text=[
      'Hi {{1}},',
      '',
      'Your tattoo session is booked for {{2}} at {{3}}.',
      '',
      'Deposit received: {{4}}',
      '{{5}}: {{6}}',
      ...(target.kind === 'booking_tattoo_cash'
        ? ['', "A little note: cash payment is preferred, if that's convenient for you. Thank you!"]
        : []),
      '',
      'Everything is confirmed. See you then!',
      'If you have any questions, just message me here.',
    ].join('\n');
    example=['Alex','Monday, 16 November 2026','12:00','£250','Remaining balance on the day','£730'];
    buttons=[
      {type:'URL',text:'Get directions',url},
      {type:'URL',text:'How to prepare',url:faq},
    ];
  } else if (target.kind === 'booking_consultation') {
    text=[
      'Hi {{1}},',
      '',
      'Your consultation is booked for {{2}} at {{3}}.',
      '',
      "We'll go through your tattoo ideas and discuss the details in person.",
      '',
      'See you then!',
    ].join('\n');
    example=['Alex','Monday, 16 November 2026','12:00'];
    buttons=[{type:'URL',text:'Get directions',url}];
  } else if (target.kind === 'booking_consultation_directions') {
    text=[
      'Hi {{1}},',
      '',
      'Your in-person consultation is booked for {{2}} at {{3}}.',
      '',
      'Studio: Label Tattoo Kensington, Unit B, York House, Avonmore Place, London W14 8RL.',
      'Use Get directions below for the correct studio on Google Maps.',
      '',
      'Your booking is already confirmed. See you then!',
    ].join('\\n');
    example=['Alex','Monday, 16 November 2026','12:00'];
    buttons=[{type:'URL',text:'Get directions',url:YORK_HOUSE_MAP}];
  } else if (target.kind === 'booking_video') {
    text=[
      'Hi {{1}},',
      '',
      'Your WhatsApp video consultation is booked for {{2}} at {{3}}.',
      '',
      "I'll video call you on WhatsApp at the scheduled time.",
      "We'll go through your tattoo ideas and discuss any questions you have.",
      '',
      'Speak soon!',
    ].join('\n');
    example=['Alex','Monday, 16 November 2026','12:00'];
  } else if (target.kind === 'reminder_72h') {
    text=[
      'Hi {{1}},',
      '',
      'Just a reminder that your tattoo session is coming up in three days.',
      '',
      'Date(s) and time(s): {{2}}',
      '',
      'Please remember that your deposit is non-refundable if you cancel within 72 hours of your appointment.',
      '',
      'Preparation guide: ' + faq,
      '',
      "Please use the buttons below to let me know if you're still able to make it.",
    ].join('\n');
    example=['Alex','16 November 2026, 12:00'];
    buttons=[
      {type:'QUICK_REPLY',text:'Confirm attendance'},
      {type:'QUICK_REPLY',text:'Need another time'},
    ];
  } else if (target.kind === 'reminder_72h_button') {
    text=[
      'Hi {{1}},',
      '',
      'Just a reminder that your tattoo session is coming up in three days.',
      '',
      'Date(s) and time(s): {{2}}',
      '',
      'Please remember that your deposit is non-refundable if you cancel within 72 hours of your appointment.',
      '',
      'Please use the buttons below to confirm your attendance or request another time.',
      'Tap How to prepare for the preparation guide.',
    ].join('\n');
    example=['Alex','16 November 2026, 12:00'];
    buttons=[
      {type:'QUICK_REPLY',text:'Confirm attendance'},
      {type:'QUICK_REPLY',text:'Need another time'},
      {type:'URL',text:'How to prepare',url:faq},
    ];
  } else if (target.kind === 'reminder_24h') {
    text=[
      'Hi {{1}},',
      '',
      'Just a quick reminder about your tattoo session tomorrow at {{2}}.',
      '',
      'Please check the arrival instructions before coming:',
      url,
      '',
      'No need to reply if everything is still fine. See you tomorrow!',
    ].join('\n');
    example=['Alex','12:00'];
    buttons=[{type:'QUICK_REPLY',text:'Need another time'}];
  } else if (target.kind === 'reminder_24h_button') {
    text=[
      'Hi {{1}},',
      '',
      'Just a reminder that your tattoo session starts tomorrow at {{2}}.',
      '',
      'Please open the arrival instructions using the button below before coming.',
      'Your booking is already confirmed, so there is no need to confirm again.',
      'If you need to change the time, use the other button.',
      '',
      'See you tomorrow!',
    ].join('\n');
    example=['Alex','12:00'];
    buttons=[
      {type:'URL',text:'Arrival instructions',url},
      {type:'QUICK_REPLY',text:'Need another time'},
    ];
  } else if (target.kind === 'reminder_consultation_button') {
    text=[
      'Hi {{1}},',
      '',
      'Just a reminder about your consultation tomorrow, {{2}}.',
      '',
      'Studio: {{3}}',
      '',
      'Your appointment is already confirmed. No need to confirm again.',
      'Use Get directions for the private studio arrival instructions.',
      'If you need to change the time, use Need another time.',
      '',
      'See you tomorrow!',
    ].join('\n');
    example=['Alex','Tuesday, 10 November 2026 at 12:00',
      'Label Tattoo Private, Exhibition House, London'];
    buttons=[
      {type:'URL',text:'Get directions',url},
      {type:'QUICK_REPLY',text:'Need another time'},
    ];
  } else if (target.kind === 'reminder_consultation_directions') {
    text=[
      'Hi {{1}},',
      '',
      'Just a reminder about our in-person consultation tomorrow, {{2}}.',
      '',
      'Studio: {{3}}',
      '',
      'Your appointment is already confirmed. No need to confirm again.',
      'Use Get directions for the York House studio on Google Maps.',
      'If you need to change the time, use Need another time.',
      '',
      'See you tomorrow!',
    ].join('\\n');
    example=['Alex','Wednesday, 11 November 2026 at 12:00',
      'Label Tattoo Kensington, Unit B, York House, Avonmore Place, London W14 8RL'];
    buttons=[
      {type:'URL',text:'Get directions',url:YORK_HOUSE_MAP},
      {type:'QUICK_REPLY',text:'Need another time'},
    ];
  } else if (target.kind === 'reminder_consultation_video') {
    text=[
      'Hi {{1}},',
      '',
      'Just a reminder about your WhatsApp video consultation tomorrow, {{2}}.',
      '',
      '{{3}}',
      '',
      "I'll video call you on WhatsApp at the scheduled time.",
      'Your appointment is already confirmed. No need to confirm again.',
      'If you need another time, use the button below.',
    ].join('\n');
    example=['Alex','Tuesday, 10 November 2026 at 12:00',
      'Video consultation: no studio visit'];
    buttons=[{type:'QUICK_REPLY',text:'Need another time'}];
  } else if (target.kind === 'reminder_consultation') {
    text=[
      'Hi {{1}},',
      '',
      'Just a reminder that we have a consultation tomorrow, {{2}}.',
      '',
      '{{3}}',
      '',
      'Please use the buttons below to let me know if the time still works for you.',
    ].join('\n');
    example=['Alex','Monday, 16 November 2026 at 12:00',
      'In person at Exhibition House, London.'];
    buttons=[
      {type:'QUICK_REPLY',text:'Confirm consultation'},
      {type:'QUICK_REPLY',text:'Need another time'},
    ];
  }
  if (!text || new TextEncoder().encode(text).length>1024) {
    throw new Error('Invalid WhatsApp Utility body');
  }
  return {
    name,language:'en_GB',category:'UTILITY',
    components:[
      {type:'BODY',text,example:{body_text:[example]}},
      ...(buttons.length?[{type:'BUTTONS',buttons}]:[]),
    ],
  };
}

function matches(actual,wanted) {
  if (!actual || actual.name!==wanted.name || actual.language!==wanted.language
      || actual.category!==wanted.category || !Array.isArray(actual.components)) return false;
  const body=actual.components.find(c=>c.type==='BODY');
  const buttons=actual.components.find(c=>c.type==='BUTTONS')?.buttons || [];
  const expected=wanted.components.find(c=>c.type==='BUTTONS')?.buttons || [];
  return body?.text===wanted.components[0].text
    && buttons.length===expected.length
    && expected.every((b,i)=>buttons[i]?.type===b.type
      && buttons[i]?.text===b.text
      && (b.type!=='URL'||buttons[i]?.url===b.url))
    && actual.components.every(c=>['BODY','BUTTONS'].includes(c.type));
}

function accountBinding(env,target) {
  const selected=resolveProviderBinding(env,{
    kind:'whatsapp_message',integration_type:'whatsapp',
    provider:'meta_cloud_api',integration_key:target.integration_key,
  });
  const {wabaId,accessToken}=selected.credentials;
  if (typeof wabaId!=='string'||!ID.test(wabaId)
      || typeof accessToken!=='string'||accessToken.length<20
      || /\s/.test(accessToken)) throw new Error('Meta WABA credentials invalid');
  return {wabaId,accessToken};
}

async function graph(binding,path,method,body,fetchImpl) {
  const options={
    method,
    headers:{
      Authorization:'Bearer '+binding.accessToken,
      Accept:'application/json',
      ...(body?{'Content-Type':'application/json'}:{}),
    },
    redirect:'manual',
    ...(body?{body:JSON.stringify(body)}:{}),
  };
  const response=await fetchImpl('https://graph.facebook.com/'+GRAPH_API_VERSION+'/'+path,options);
  if (!response.ok) {
    let code='whatsapp_template_provider_error';
    try {
      const p=await response.clone().json();
      if (p?.error?.code===100 && p.error.error_subcode===2494160) {
        code='whatsapp_template_api_unavailable_for_account';
      }
    } catch {}
    const err=new Error('Meta proposal request failed');err.code=code;throw err;
  }
  const result=await response.json();
  if (typeof result!=='object'||!result) throw new Error('Invalid Meta proposal response');
  return result;
}

async function list(binding,fetchImpl) {
  const fields='id,name,status,language,category,components';
  const path=binding.wabaId+'/message_templates?fields='+encodeURIComponent(fields)+'&limit=100';
  const result=await graph(binding,path,'GET',null,fetchImpl);
  if (!Array.isArray(result?.data)) throw new Error('Meta proposal list invalid');
  return result.data;
}

function safeCode(error) {
  return typeof error?.code==='string' && /^[a-z][a-z0-9_]{2,63}$/.test(error.code)
    ?error.code:'whatsapp_template_maintenance_failed';
}

export async function maintainWhatsappTemplateProposals(env,{limit=6,fetchImpl=fetch}={}) {
  if (!Number.isInteger(limit)||limit<1||limit>20) throw new Error('Invalid proposal batch');
  const db=createSupabaseClient(env,fetchImpl);
  const claimed=await db.rpc('service_claim_whatsapp_template_proposals',{p_limit:limit});
  const targets=Array.isArray(claimed)?claimed:claimed==null?[]:[claimed];
  if (targets.length>limit) throw new Error('Unexpected proposal claim count');
  const result={targets:targets.length,checked:0,created:0,approved:0,failed:0};
  for (const target of targets) {
    try {
      const expected=definition(target);
      const binding=accountBinding(env,target);
      let rows=await list(binding,fetchImpl);
      let matchesName=rows.filter(x=>x?.name===expected.name&&x?.language==='en_GB');
      if (!matchesName.length) {
        const created=await graph(binding,binding.wabaId+'/message_templates',
          'POST',expected,fetchImpl);
        if (typeof created.id!=='string'||!ID.test(created.id)) {
          throw new Error('Meta proposal ID unavailable after create');
        }
        result.created++;
        rows=await list(binding,fetchImpl);
        matchesName=rows.filter(x=>x?.name===expected.name&&x?.language==='en_GB');
      }
      if (matchesName.length!==1||!matches(matchesName[0],expected)) {
        const error=new Error('Meta proposal differs from approved design');
        error.code='whatsapp_template_contract_mismatch';throw error;
      }
      const row=matchesName[0];
      const status=typeof row.status==='string'?row.status.toUpperCase():'';
      if (!['PENDING','APPROVED','PAUSED','REJECTED'].includes(status)
          ||(status==='APPROVED'&&!ID.test(row.id??''))) {
        throw new Error('Meta proposal status invalid');
      }
      await db.rpc('service_record_whatsapp_template_proposal',{
        p_artist_id:target.artist_id,p_kind:target.kind,
        p_template_name:target.template_name,p_status:status,
        p_provider_template_id:status==='APPROVED'?row.id:null,
        p_failure_code:null,
      });
      result.checked++;
      if(status==='APPROVED')result.approved++;
    } catch(error) {
      result.failed++;
      try {
        await db.rpc('service_record_whatsapp_template_proposal',{
          p_artist_id:target.artist_id,p_kind:target.kind,
          p_template_name:target.template_name,
          p_status:'UNKNOWN',p_provider_template_id:null,
          p_failure_code:safeCode(error),
        });
      } catch {}
    }
  }
  return result;
}

export const __testing={
  definition,
  matches,
};
