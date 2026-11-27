/* Release candidate. Preview has no network submission. Production requires a separately tested backend. */
(() => {
  'use strict';
  const form = document.querySelector('#guide-form');
  const status = document.querySelector('#form-status');
  const submit = document.querySelector('#submit');
  const success = document.querySelector('#success');
  const preview = document.body.dataset.mode !== 'live';
  const endpoint = 'https://api.vishartattoo.com/api/lead-magnets/cover-up-guide';
  const expectedDownload = 'https://vishartattoo.com/assets/lead-magnets/cover-up-guide-v6.pdf';
  let pending = false, requestId = null, lastFingerprint = null;
  function setStatus(message, error = false) { status.textContent = message; status.classList.toggle('error', error); }
  function showSuccess(url, message) {
    const link = document.querySelector('#download'); link.href = url;
    document.querySelector('#success-text').textContent = message;
    success.hidden = false; submit.hidden = true; setStatus('');
    success.scrollIntoView({block:'nearest'}); link.focus();
  }
  // Separate, unchecked permission. No full URLs, click IDs, or contact details.
  function attribution() {
    if(!form.elements.namedItem('attribution').checked)return {};
    const tags={consent_version:'guide-attribution-v1'},params=new URLSearchParams(location.search);
    for(const key of ['utm_source','utm_medium','utm_campaign','utm_term','utm_content']) {
      const v=params.get(key);if(v&&v.length<=160&&/^[A-Za-z0-9_.-]+$/.test(v))tags[key]=v;
    }
    return tags;
  }
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (pending || !success.hidden) return;
    if (!form.reportValidity()) return;
    const name = form.elements.namedItem('name').value.trim(); const email = form.elements.namedItem('email').value.trim().toLowerCase();
    if (!name || !email) { setStatus('Please enter your first name and email.', true); return; }
    if (form.elements.namedItem('website').value) { setStatus('Unable to process this request.', true); return; }
    if (preview) { showSuccess('#get-guide','Preview only. The private PDF is supplied separately in the launch pack. No email was sent.'); document.querySelector('#download').textContent='PDF supplied separately'; return; }
    const source=attribution();
    const fingerprint = JSON.stringify([name, email, form.elements.namedItem('marketing').checked,source]);
    if (fingerprint !== lastFingerprint) { requestId = crypto.randomUUID(); lastFingerprint = fingerprint; }
    pending = true; submit.disabled = true; setStatus('Preparing your guide…');
    try {
      const response = await fetch(endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({request_id:requestId, first_name:name, email, marketing_opt_in:form.elements.namedItem('marketing').checked, marketing_consent_version:'coverup-email-v1', website:'', attribution:source}), credentials:'omit', cache:'no-store', signal:AbortSignal.timeout(15000)});
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true || data.download_url !== expectedDownload) throw new Error('delivery_not_confirmed');
      showSuccess(data.download_url, 'Your request is confirmed. You can open the PDF now. A copy of the link has been queued for email delivery.');
      // Dedicated first-party success event; never use the tattoo-enquiry Lead event.
      if(source.consent_version)window.dispatchEvent(new CustomEvent('GuideRequested',{detail:{eventId:requestId,magnet:'cover-up-guide'}}));
    } catch { setStatus('We couldn’t confirm your request. Please try again. No booking has been created.', true); }
    finally { pending = false; submit.disabled = false; }
  });
  submit.disabled = false;
})();
