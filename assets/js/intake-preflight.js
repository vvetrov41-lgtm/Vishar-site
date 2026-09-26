(function(){
  'use strict';
  var FIELDS=['projectType','placement','size','idea','coverUp'];
  var TIMEOUT_MS=2500;
  function snapshot(form){var d=new FormData(form);return FIELDS.map(function(f){return String(d.get(f)||'').trim();}).join('\u241f');}
  function create(options){
    var form=options.form,endpoint=options.endpoint,enabled=Boolean(options.enabled);
    var stage='none',id='',choice='',before='',notice=null;
    function ensureId(){
      if(id)return id;
      try{if(window.crypto&&typeof window.crypto.randomUUID==='function')id=window.crypto.randomUUID();}catch(e){}
      return id;
    }
    function preflightEndpoint(){
      try{var u=new URL(endpoint,window.location.href);u.searchParams.set('preflight','1');return u.toString();}catch(e){return endpoint;}
    }
    function clearHints(){Array.prototype.forEach.call(form.querySelectorAll('[data-preflight-hint]'),function(n){n.remove();});if(notice){notice.remove();notice=null;}}
    function hint(field,text){
      var el=form.elements[field];if(!el||typeof el.insertAdjacentElement!=='function')return null;
      var existing=form.querySelectorAll('[data-preflight-hint="'+field+'"]');
      var p=document.createElement('span');p.setAttribute('data-preflight-hint',field);p.setAttribute('role','note');
      p.style.cssText='display:block;margin-top:8px;padding:8px 10px;border-left:3px solid #f5c26b;background:rgba(245,194,107,.08);color:#f5dfb4;font-size:14px;line-height:1.5;border-radius:6px';
      p.textContent=text;var anchor=existing.length?existing[existing.length-1]:el;anchor.insertAdjacentElement('afterend',p);
      el.addEventListener('input',function(){p.remove();},{once:true});
      return el;
    }
    function showNotice(){
      notice=document.createElement('div');notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
      notice.style.cssText='margin-top:16px;padding:12px 14px;border:1px solid rgba(245,194,107,.35);border-radius:12px;color:#f5dfb4;font-size:15px;line-height:1.5';
      var text=document.createElement('p');text.style.margin='0 0 10px';
      text.textContent='A little more detail above would help the artist reply sooner. Update it and send, or send it as it is.';
      var send=document.createElement('button');send.type='button';send.textContent='Send anyway';
      send.style.cssText='min-height:44px;padding:10px 18px;border-radius:999px;border:1px solid rgba(255,255,255,.4);background:transparent;color:inherit;font:inherit;cursor:pointer';
      send.addEventListener('click',function(){if(typeof form.requestSubmit==='function')form.requestSubmit();else if(options.submitButton)options.submitButton.click();});
      notice.appendChild(text);notice.appendChild(send);
      var anchor=options.submitButton||form.lastElementChild;
      if(anchor&&anchor.parentNode)anchor.parentNode.insertBefore(notice,anchor);else form.appendChild(notice);
    }
    function mark(payload){if(id){payload.append('preflightId',id);payload.append('preflightChoice',choice||'unchanged');}}
    async function gate(payload){
      if(!enabled)return true;
      if(stage==='clarified'){choice=snapshot(form)!==before?'corrected':'send_anyway';stage='done';clearHints();mark(payload);return true;}
      if(stage==='done'){mark(payload);return true;}
      stage='done';choice='unchanged';ensureId();
      var body=new FormData();var count=0;
      payload.forEach(function(value,key){if(key==='references'){count+=1;return;}if(key==='preflightId'||key==='preflightChoice')return;body.append(key,value);});
      body.append('preflight','1');body.append('referenceCount',String(Math.min(count,3)));if(id)body.append('preflightId',id);
      var controller=typeof AbortController==='function'?new AbortController():null;
      var timer=controller?setTimeout(function(){controller.abort();},TIMEOUT_MS):null;
      var result=null;
      try{
        var response=await fetch(preflightEndpoint(),{method:'POST',body:body,credentials:'same-origin',signal:controller?controller.signal:undefined});
        if(response.ok){var json=await response.json().catch(function(){return null;});result=json&&json.ok&&json.preflight?json.preflight:null;}
      }catch(e){result=null;}finally{if(timer)clearTimeout(timer);}
      if(!result){mark(payload);return true;}
      if(typeof result.id==='string'&&result.id)id=result.id;
      var messages=Array.isArray(result.messages)?result.messages.slice(0,3):[];
      if(result.status!=='clarify'||!messages.length){mark(payload);return true;}
      clearHints();var first=null;
      messages.forEach(function(m){var el=hint(m&&m.field,String(m&&m.text||''));if(el&&!first)first=el;});
      if(!first){mark(payload);return true;}
      showNotice();before=snapshot(form);stage='clarified';
      try{first.scrollIntoView({behavior:'smooth',block:'center'});}catch(e){first.scrollIntoView();}
      return false;
    }
    return {gate:gate};
  }
  window.VisharIntakePreflight={create:create};
})();
