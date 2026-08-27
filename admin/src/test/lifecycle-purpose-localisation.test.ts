import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lifecyclePurposeLabel } from '../pages/LifecycleAutomationPage';
import type { ClientLifecyclePurpose } from '../lib/lifecycle-api';

const PURPOSES: ClientLifecyclePurpose[] = [
  { purpose: 'consultation_reminder', classification: 'service', description: 'Reminds a client of a booked consultation.' },
  { purpose: 'deposit_confirmation', classification: 'service', description: 'Confirms receipt of a deposit.' },
  { purpose: 'deposit_policy', classification: 'service', description: 'Explains the deposit policy.' },
  { purpose: 'deposit_request', classification: 'service', description: 'Requests a deposit.' },
  { purpose: 'new_enquiry_ack', classification: 'service', description: 'Acknowledges a new enquiry.' },
  { purpose: 'no_response_followup', classification: 'service', description: 'Follows up when there is no reply.' },
  { purpose: 'post_session_checkin', classification: 'service', description: 'Checks in after a session.' },
  { purpose: 'session_reminder_24h', classification: 'service', description: 'Reminds a client 24 hours before a session.' },
  { purpose: 'session_reminder_72h', classification: 'service', description: 'Reminds a client 72 hours before a session.' },
  { purpose: 'session_reminder_7d', classification: 'service', description: 'Reminds a client 7 days before a session.' },
];

describe('lifecycle purpose localisation', () => {
  it('maps the complete production service-purpose catalogue to operator-facing Russian labels', () => {
    const expected: Record<string, string> = {
      consultation_reminder: 'Напоминание о консультации',
      deposit_confirmation: 'Подтверждение депозита',
      deposit_policy: 'Условия депозита',
      deposit_request: 'Запрос депозита',
      new_enquiry_ack: 'Подтверждение новой заявки',
      no_response_followup: 'Напоминание без ответа',
      post_session_checkin: 'Сообщение после сеанса',
      session_reminder_24h: 'Напоминание о сеансе за 24 часа',
      session_reminder_72h: 'Напоминание о сеансе за 72 часа',
      session_reminder_7d: 'Напоминание о сеансе за 7 дней',
    };

    for (const purpose of PURPOSES) {
      expect(lifecyclePurposeLabel(purpose.purpose, PURPOSES, true)).toBe(expected[purpose.purpose]);
    }
  });

  it('fails closed in Russian for a future unknown purpose instead of leaking a raw code or English description', () => {
    const future = [
      ...PURPOSES,
      { purpose: 'future_service_event', classification: 'service', description: 'Future English description.' },
    ] as ClientLifecyclePurpose[];

    expect(lifecyclePurposeLabel('future_service_event', future, true)).toBe('Сервисное сообщение');
    expect(lifecyclePurposeLabel('future_service_event', future, false)).toBe('Future English description.');
  });

  it('routes every visible purpose surface through the shared label helper', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/pages/LifecycleAutomationPage.tsx'),
      'utf8',
    );

    for (const forbidden of [
      "{' · '}{rule.message_purpose}",
      "{' · '}{row.message_purpose}",
      '<strong>{template.subject || template.purpose}</strong>',
      '<option key={item.purpose} value={item.purpose}>{item.purpose}</option>',
    ]) {
      expect(source).not.toContain(forbidden);
    }

    expect(source).toContain('lifecyclePurposeLabel(rule.message_purpose, data.purposes, ru)');
    expect(source).toContain('lifecyclePurposeLabel(row.message_purpose, purposes, ru)');
    expect(source).toContain('lifecyclePurposeLabel(template.purpose, data.purposes, ru)');
    expect(source.match(/lifecyclePurposeLabel\(item\.purpose, purposes, ru\)/g)?.length).toBe(2);
  });
});
