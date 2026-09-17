import {
  CalendarConnectorError,
  validateCalendarRoute,
} from './google-calendar.js';

const GOOGLE_PEOPLE_BASE_URL = 'https://people.googleapis.com/v1';
export const GOOGLE_CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts';
const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const SEARCH_WARMUP_DELAY_MS = 5000;

function cleanName(value) {
  const cleaned = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
    : '';
  if (!cleaned || cleaned.length > 160) {
    throw new CalendarConnectorError('google_contact_job_invalid');
  }
  return cleaned;
}

function normalizedPhone(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (E164_PATTERN.test(trimmed)) return trimmed;
  const compact = trimmed.replace(/[\s().-]/g, '');
  return E164_PATTERN.test(compact) ? compact : '';
}

function normalizedEmail(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new CalendarConnectorError('google_contact_job_invalid');
  }
  const cleaned = value.trim().toLowerCase();
  if (!cleaned || cleaned.length > 320 || !EMAIL_PATTERN.test(cleaned)) {
    throw new CalendarConnectorError('google_contact_job_invalid');
  }
  return cleaned;
}

function peopleError(status) {
  if (status === 401) return new CalendarConnectorError('calendar_oauth_expired');
  if (status === 403) return new CalendarConnectorError('google_contacts_permission_denied');
  if (status === 429 || status >= 500) {
    return new CalendarConnectorError('google_contacts_provider_unavailable');
  }
  return new CalendarConnectorError('google_contacts_provider_rejected');
}

async function peopleFetch(fetchImpl, url, init) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new CalendarConnectorError('google_contacts_provider_unavailable');
  }
  if (!response.ok) throw peopleError(response.status);
  return response;
}

export function validateGoogleContactsRoute(route, job) {
  const calendar = validateCalendarRoute(route, job);
  if (route?.configuration?.google_contacts_sync !== true) {
    throw new CalendarConnectorError('google_contacts_not_enabled');
  }
  return calendar.artist;
}

export function validateGoogleContactsTokenScope(tokenRecord) {
  const scopes = typeof tokenRecord?.scope === 'string'
    ? new Set(tokenRecord.scope.split(/\s+/).filter(Boolean))
    : new Set();
  if (!scopes.has(GOOGLE_CONTACTS_SCOPE)) {
    throw new CalendarConnectorError('google_contacts_scope_missing');
  }
  return tokenRecord;
}

export function buildGoogleContact(job) {
  const phone = normalizedPhone(job?.phone_normalized);
  if (!phone) throw new CalendarConnectorError('google_contact_job_invalid');

  const body = {
    names: [{ unstructuredName: cleanName(job?.client_display_name) }],
    phoneNumbers: [{ value: phone, type: 'mobile' }],
  };
  const email = normalizedEmail(job?.email_normalized);
  if (email) body.emailAddresses = [{ value: email }];

  return { phone, body };
}

export function createGoogleContactsProvider({
  accessToken,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new CalendarConnectorError('calendar_not_configured');
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
  let warmed = false;

  async function warmSearch() {
    if (warmed) return;
    const params = new URLSearchParams({
      query: '',
      readMask: 'phoneNumbers',
      pageSize: '1',
    });
    await peopleFetch(fetchImpl, `${GOOGLE_PEOPLE_BASE_URL}/people:searchContacts?${params}`, {
      headers,
    });
    await sleepImpl(SEARCH_WARMUP_DELAY_MS);
    warmed = true;
  }

  async function hasExactPhone(phone) {
    const normalized = normalizedPhone(phone);
    if (!normalized) throw new CalendarConnectorError('google_contact_job_invalid');
    await warmSearch();

    const params = new URLSearchParams({
      query: normalized,
      readMask: 'phoneNumbers',
      pageSize: '30',
    });
    const response = await peopleFetch(
      fetchImpl,
      `${GOOGLE_PEOPLE_BASE_URL}/people:searchContacts?${params}`,
      { headers },
    );
    const payload = await response.json().catch(() => null);
    if (!payload || !Array.isArray(payload.results)) {
      throw new CalendarConnectorError('google_contacts_provider_rejected');
    }

    return payload.results.some((result) => {
      const numbers = Array.isArray(result?.person?.phoneNumbers)
        ? result.person.phoneNumbers
        : [];
      return numbers.some((item) => {
        const canonical = normalizedPhone(item?.canonicalForm);
        const raw = normalizedPhone(item?.value);
        return canonical === normalized || raw === normalized;
      });
    });
  }

  async function createContact(job) {
    const { phone, body } = buildGoogleContact(job);
    const params = new URLSearchParams({
      personFields: 'metadata,names,phoneNumbers,emailAddresses',
    });
    await peopleFetch(fetchImpl, `${GOOGLE_PEOPLE_BASE_URL}/people:createContact?${params}`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { phone };
  }

  return {
    warmSearch,
    hasExactPhone,
    createContact,
  };
}

export const __testing = {
  E164_PATTERN,
  SEARCH_WARMUP_DELAY_MS,
  normalizedPhone,
  normalizedEmail,
  cleanName,
  peopleError,
};
