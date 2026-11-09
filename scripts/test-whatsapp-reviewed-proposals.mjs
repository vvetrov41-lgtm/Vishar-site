import assert from 'node:assert/strict';
import { __testing } from '../workers/lib/whatsapp-reviewed-proposals.js';

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
console.log('All 12 reviewed WhatsApp proposals keep approved copy and artist-isolated URLs.');
