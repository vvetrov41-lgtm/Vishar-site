import assert from 'node:assert/strict';
import {
  __testing, WhatsappAudioError, transcribeWhatsappAudio, drainWhatsappAudioTranscriptions,
} from '../workers/lib/whatsapp-audio.js';

const ARTIST = 'a1111111-1111-4111-8111-111111111111';
const OTHER = 'a2222222-2222-4222-8222-222222222222';
const JOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEDIA_ID = '123456789012';
const data = new TextEncoder().encode('fake audio');
let modelCalls = 0;
const env = {
  VISHAR_ENVIRONMENT: 'production',
  WHATSAPP_AUDIO_TRANSCRIPTION_ENABLED: 'true',
  ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION: JSON.stringify({
    artistId: ARTIST,
    integrationKey: 'vladimir-production',
    phoneNumberId: '100000000001',
    accessToken: 'synthetic-test-token',
  }),
  AI: {
    async run(model, input) {
      modelCalls++;
      assert.equal(model, '@cf/openai/whisper-large-v3-turbo');
      assert.equal(input.audio, Buffer.from(data).toString('base64'));
      assert.equal(input.task, 'transcribe');
      return { text: ' I will think about the portrait. ' };
    },
  },
};
const job = { job_id: JOB, artist_id: ARTIST, integration_key: 'vladimir-production', media_id: MEDIA_ID };
let called = [];
const fetchImpl = async (url, init) => {
  called.push({url,init});
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.Authorization, 'Bearer synthetic-test-token');
  if (url.startsWith('https://graph.facebook.com/')) {
    assert.equal(url, 'https://graph.facebook.com/v25.0/123456789012?phone_number_id=100000000001');
    return Response.json({url:'https://lookaside.fbsbx.com/whatsapp?sig=123',mime_type:'audio/ogg',file_size:data.byteLength});
  }
  return new Response(data, {headers:{'content-length':String(data.byteLength),'content-type':'audio/ogg'}});
};

assert.equal(await transcribeWhatsappAudio(env, job, fetchImpl), 'I will think about the portrait.');
assert.equal(modelCalls, 1);
assert.equal(called.length, 2);

for (const target of [
  'https://malicious.invalid/audio',
  'http://lookaside.fbsbx.com/audio',
  'https://lookaside.fbsbx.com.evil.test/audio',
  'https://user:password@lookaside.fbsbx.com/audio',
  'https://127.0.0.1/file',
]) assert.equal(__testing.validMediaUrl(target), false);
assert.equal(__testing.validMediaUrl('https://lookaside.fbsbx.com/media?sig=abc'), true);

await assert.rejects(
  transcribeWhatsappAudio(env, {...job,artist_id:OTHER}, fetchImpl),
  error => error instanceof WhatsappAudioError && error.code === 'whatsapp_audio_artist_mismatch',
);
await assert.rejects(
  transcribeWhatsappAudio(env, {...job,media_id:'invalid-media-id'}, fetchImpl),
  error => error.code === 'whatsapp_audio_job_invalid',
);
assert.equal(modelCalls, 1, 'a route mismatch must not invoke inference');

const records = [];
const supabase = {
  async rpc(name, args) {
    records.push({name,args});
    if(name === 'service_claim_whatsapp_audio_transcriptions') return [job];
    if(name === 'service_complete_whatsapp_audio_transcription') return {completed:true};
    throw new Error('unexpected rpc');
  },
};
const result = await drainWhatsappAudioTranscriptions(env, {supabase,fetchImpl,workerId:'audio-unit-test'});
assert.deepEqual(result, {skipped:false,claimed:1,succeeded:1,failed:0,unrecorded:0});
assert.equal(records.length,2);
assert.deepEqual(records[1].args, {
  p_job_id:JOB,p_worker_id:'audio-unit-test',
  p_transcript:'I will think about the portrait.',p_error_code:null,
});
assert.ok(!JSON.stringify(records).includes('synthetic-test-token'));

const disabled = await drainWhatsappAudioTranscriptions({...env,WHATSAPP_AUDIO_TRANSCRIPTION_ENABLED:'false'},{
  supabase:{rpc(){throw Error('disabled means no claims');}},
});
assert.deepEqual(disabled,{skipped:true,claimed:0,succeeded:0,failed:0,unrecorded:0});
assert.equal(modelCalls,2);

const failRecords = [];
const failure = await drainWhatsappAudioTranscriptions({
  ...env,AI:{run(){throw new Error('sensitive provider body');}},
},{
  supabase:{async rpc(name,args){failRecords.push({name,args});return name === 'service_claim_whatsapp_audio_transcriptions'?[job]:{};}},
  fetchImpl,workerId:'audio-unit-test',
});
assert.equal(failure.failed,1);
assert.equal(failRecords[1].args.p_error_code,'whatsapp_audio_inference_failed');
assert.equal(failRecords[1].args.p_transcript,null);
assert.ok(!JSON.stringify(failRecords).includes('sensitive provider body'));

console.log('WhatsApp audio tests passed: token isolation, authenticated downloads, bounded inference, retries, safe failure codes, no sends.');
