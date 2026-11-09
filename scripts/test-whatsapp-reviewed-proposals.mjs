import assert from 'node:assert/strict';
import { ALLOWED_RPCS } from '../workers/lib/supabase.js';
import { __testing } from '../workers/lib/whatsapp-reviewed-proposals.js';

assert.ok(ALLOWED_RPCS.has('service_claim_whatsapp_template_proposals'));
assert.ok(ALLOWED_RPCS.has('service_record_whatsapp_template_proposal'));
const artists = [
  ['a1111111-1111-4111-8111-111111111111',
    'https://vishartattoo.com/arrival/7f2bc57edcd447adbe549e36a5a1830f/',
    'https://vishartattoo.com/faq/'],
  ['a2222222-2222-4222-8222-222222222222',
    'https://www.kristinavishar.com/arrival/8be014526ee14b7190c8c559c59624ea/',
    'https://www.kristinavishar.com/faq/'],
];
const names = {
  booking_tattoo:'booking_card_tattoo_v2',
  booking_consultation:'booking_card_consultation_v2',
  booking_video:'booking_card_video_consultation_v2',
  reminder_72h:'vishar_lifecycle_reminder_72h_v3',
  reminder_24h:'vishar_lifecycle_reminder_24h_v3',
  reminder_consultation:'vishar_lifecycle_consultation_v4',
};
for (const [artist_id,arrival_guide_url,preparation_guide_url] of artists) {
  for (const [kind,template_name] of Object.entries(names)) {
    const target={
      artist_id,arrival_guide_url,preparation_guide_url,kind,template_name,
      template_language:'en_GB',
    };
    const definition=__testing.definition(target);
    assert.equal(definition.category,'UTILITY');
    assert.equal(definition.name,template_name);
    const body=definition.components.find(c=>c.type==='BODY');
    const buttons=definition.components.find(c=>c.type==='BUTTONS')?.buttons||[];
    assert.ok(body?.text.startsWith('Hi {{1}},'));
    assert.ok(body.text.length<1024);
    assert.ok(!body.text.includes("it's Vladimir"));
    assert.ok(!body.text.includes('Artist:'));
    assert.ok(!body.text.includes('York House'));
    assert.ok(__testing.matches({
      ...definition,id:'1234567890123',status:'APPROVED',
    },definition));
    assert.equal(buttons.length,({
      booking_tattoo:2,booking_consultation:1,booking_video:0,
      reminder_72h:2,reminder_24h:1,reminder_consultation:2,
    })[kind]);
    if(kind.startsWith('booking_')) {
      assert.ok(buttons.every(x=>x.type==='URL'));
      assert.ok(!body.text.includes('Please confirm'));
      assert.ok(!body.text.includes('Need another time'));
    } else {
      assert.ok(buttons.every(x=>x.type==='QUICK_REPLY'));
    }
    if(kind==='booking_tattoo') {
      assert.deepEqual(buttons.map(x=>x.text),['Get directions','How to prepare']);
      assert.ok(body.text.includes('Remaining')===false); // label is price/date-dependent
      assert.ok(body.text.includes('Deposit received'));
    }
    if(kind==='booking_video') {
      assert.ok(body.text.includes("I'll video call you on WhatsApp"));
      assert.ok(!body.text.includes('Studio'));
    }
    if(kind==='reminder_72h') {
      assert.deepEqual(buttons.map(x=>x.text),['Confirm attendance','Need another time']);
    }
    if(kind==='reminder_24h') {
      assert.deepEqual(buttons.map(x=>x.text),['Need another time']);
      assert.ok(body.text.includes(arrival_guide_url));
    }
    if(kind==='reminder_consultation') {
      assert.deepEqual(buttons.map(x=>x.text),['Confirm consultation','Need another time']);
      assert.ok(!body.text.includes('York House'));
    }
    const tampered=structuredClone(definition);
    tampered.components[0].text+='\\nConfirm now';
    assert.equal(__testing.matches({...definition,components:tampered.components},definition),false);
    if (buttons.length) {
      const wrong=structuredClone(definition);
      wrong.components.at(-1).buttons[0].text='Unapproved action';
      assert.equal(__testing.matches({...definition,components:wrong.components},definition),false);
    }
    const wrongHost={...target,arrival_guide_url:'https://attacker.example/arrival/7f2bc57edcd447adbe549e36a5a1830f/'};
    assert.throws(()=>__testing.definition(wrongHost));
  }
}
// Stage a single Vladimir-only 72h candidate. The previous v3 identity stays
// intact; real attendance/reschedule actions occupy button indices 0 and 1,
// while a static FAQ URL is the third button.
const reminder72hCandidate=__testing.definition({
  artist_id:artists[0][0],
  arrival_guide_url:artists[0][1],
  preparation_guide_url:artists[0][2],
  kind:'reminder_72h_button',
  template_name:'vishar_lifecycle_reminder_72h_v4',
  template_language:'en_GB',
});
const buttons72h=reminder72hCandidate.components.find(c=>c.type==='BUTTONS').buttons;
assert.deepEqual(buttons72h.map(x=>[x.type,x.text]),[
  ['QUICK_REPLY','Confirm attendance'],
  ['QUICK_REPLY','Need another time'],
  ['URL','How to prepare'],
]);
assert.equal(buttons72h[2].url,'https://vishartattoo.com/faq/');
assert.equal(reminder72hCandidate.components[0].text.includes('Preparation guide: https://'),false);
assert.ok(__testing.matches({
  ...reminder72hCandidate,id:'1234567890123',status:'PENDING',
},reminder72hCandidate));
const changedFaq=structuredClone(reminder72hCandidate);
changedFaq.components.at(-1).buttons[2].url='https://different.example/faq/';
assert.equal(__testing.matches(changedFaq,reminder72hCandidate),false);

console.log('12 reviewed WhatsApp templates plus one Vladimir-only 72h three-button candidate passed.');
