import {receiveWake,consumeWake} from './lib/outbox-wake.js';
export default {
  fetch(request,env){return receiveWake(request,env);},
  queue(batch,env){return consumeWake(batch,env);},
};
