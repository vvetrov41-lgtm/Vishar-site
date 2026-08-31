import { describe, expect, it } from 'vitest';
import type { ClientLifecycleTemplate } from '../lib/lifecycle-api';
import { groupTemplates } from '../pages/ClientMessagesPage';

function template(overrides: Partial<ClientLifecycleTemplate>): ClientLifecycleTemplate {
  return {
    id: 'template',
    workspace_id: 'workspace',
    artist_id: null,
    template_scope: 'workspace',
    purpose: 'consultation_reminder',
    classification: 'service',
    purpose_description: 'Reminder',
    channel: 'email',
    locale: 'en',
    version: 1,
    status: 'active',
    subject: null,
    body: 'workspace copy',
    created_at: '2026-08-31T00:00:00Z',
    updated_at: '2026-08-31T00:00:00Z',
    ...overrides,
  };
}

describe('client message template scope selection', () => {
  it('prefers an active artist override even when the workspace version number is higher', () => {
    const [slot] = groupTemplates([
      template({ id: 'workspace-active', version: 9, body: 'old workspace text' }),
      template({
        id: 'artist-active',
        artist_id: 'artist',
        template_scope: 'artist',
        version: 1,
        body: 'saved artist text',
      }),
    ]);

    expect(slot.active?.id).toBe('artist-active');
    expect(slot.source.id).toBe('artist-active');
  });

  it('shows an artist draft while keeping the workspace active version as the currently sent text', () => {
    const [slot] = groupTemplates([
      template({ id: 'workspace-active', version: 4, body: 'currently sent' }),
      template({
        id: 'artist-draft',
        artist_id: 'artist',
        template_scope: 'artist',
        version: 1,
        status: 'draft',
        body: 'new draft',
      }),
    ]);

    expect(slot.active?.id).toBe('workspace-active');
    expect(slot.draft?.id).toBe('artist-draft');
    expect(slot.source.id).toBe('artist-draft');
  });

  it('does not surface a workspace draft over an active artist override', () => {
    const [slot] = groupTemplates([
      template({ id: 'workspace-active', version: 4 }),
      template({ id: 'workspace-draft', version: 5, status: 'draft', body: 'workspace draft' }),
      template({
        id: 'artist-active',
        artist_id: 'artist',
        template_scope: 'artist',
        version: 1,
        body: 'artist active',
      }),
    ]);

    expect(slot.active?.id).toBe('artist-active');
    expect(slot.draft).toBeNull();
    expect(slot.source.id).toBe('artist-active');
  });
});
