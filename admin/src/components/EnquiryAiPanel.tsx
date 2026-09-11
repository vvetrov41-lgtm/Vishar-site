import type { AiIntakeApi } from '../lib/ai-intake-api';
import type { Language } from '../lib/i18n';

/**
 * Enquiry AI is intentionally hidden from the CRM while the feature is paused.
 * Returning null removes the whole card from layout and prevents UI-side reads,
 * retries and polling without deleting the backend implementation.
 */
export function EnquiryAiPanel(_props: {
  enquiryId: string;
  api: AiIntakeApi;
  language: Language;
  mayEdit: boolean;
}) {
  return null;
}
