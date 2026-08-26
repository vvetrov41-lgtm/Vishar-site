from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one guarded match, found {count}')
    p.write_text(text.replace(old, new, 1))


page = 'admin/src/pages/LifecycleAutomationPage.tsx'
test = 'admin/src/test/lifecycle-automation-page.test.tsx'

replace_once(page,
'''import type {
  ClientLifecyclePreview,
''',
'''import type {
  ClientLifecycleExecutionHistoryRow,
  ClientLifecyclePreview,
''')

replace_once(page,
'''  variables: ClientLifecycleVariable[];
  previewSessions: ClientLifecyclePreviewSession[];
  canManage: boolean;
  canPreview: boolean;
''',
'''  variables: ClientLifecycleVariable[];
  previewSessions: ClientLifecyclePreviewSession[];
  history: ClientLifecycleExecutionHistoryRow[];
  canManage: boolean;
  canPreview: boolean;
  canHistory: boolean;
''')

replace_once(page,
'''const PREVIEW_CAPABILITIES = [
  'view_automations',
  'view_sessions',
  'view_clients',
  'view_enquiries',
  'view_integrations',
  'view_finance',
] as const;
''',
'''const PREVIEW_CAPABILITIES = [
  'view_automations',
  'view_sessions',
  'view_clients',
  'view_enquiries',
  'view_integrations',
  'view_finance',
] as const;

const HISTORY_CAPABILITIES = [
  'view_automations',
  'view_sessions',
  'view_clients',
  'view_integrations',
] as const;
''')

replace_once(page,
'''    const [rules, templates, purposes, variables, previewSessions, capabilities, context] = await Promise.all([
      api.listClientLifecycleRules(selectedArtistId),
      api.listClientLifecycleTemplates(selectedArtistId),
      api.listClientLifecycleTemplatePurposes(selectedArtistId),
      api.listClientLifecycleTemplateVariables(selectedArtistId),
      api.listClientLifecyclePreviewSessions(selectedArtistId),
      api.listCapabilities(selectedArtistId),
''',
'''    const [rules, templates, purposes, variables, previewSessions, history, capabilities, context] = await Promise.all([
      api.listClientLifecycleRules(selectedArtistId),
      api.listClientLifecycleTemplates(selectedArtistId),
      api.listClientLifecycleTemplatePurposes(selectedArtistId),
      api.listClientLifecycleTemplateVariables(selectedArtistId),
      api.listClientLifecyclePreviewSessions(selectedArtistId),
      api.listClientLifecycleExecutionHistory(selectedArtistId),
      api.listCapabilities(selectedArtistId),
''')

replace_once(page,
'''      variables,
      previewSessions,
      canManage: granted.has('manage_automations'),
      canPreview: PREVIEW_CAPABILITIES.every((capability) => granted.has(capability)),
      workspaceId: context.workspace_id,
''',
'''      variables,
      previewSessions,
      history,
      canManage: granted.has('manage_automations'),
      canPreview: PREVIEW_CAPABILITIES.every((capability) => granted.has(capability)),
      canHistory: HISTORY_CAPABILITIES.every((capability) => granted.has(capability)),
      workspaceId: context.workspace_id,
''')

replace_once(page,
'''      </Section>

      <Section title={ru ? 'Правила' : 'Rules'}>
''',
'''      </Section>

      <Section title={ru ? 'История выполнения' : 'Execution history'}>
        <LifecycleExecutionHistoryPanel
          key={selectedArtistId}
          ru={ru}
          rows={data.history}
          canView={data.canHistory}
        />
      </Section>

      <Section title={ru ? 'Правила' : 'Rules'}>
''')

history_component = '''function LifecycleExecutionHistoryPanel({
  ru,
  rows,
  canView,
}: {
  ru: boolean;
  rows: ClientLifecycleExecutionHistoryRow[];
  canView: boolean;
}) {
  if (!canView) {
    return (
      <EmptyState
        compact
        title={ru ? 'История недоступна' : 'History unavailable'}
        hint={ru
          ? 'Для истории нужен доступ к автоматизациям, клиентам, записям и интеграциям этого мастера.'
          : 'History requires access to this artist’s automations, clients, appointments and integrations.'}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        title={ru ? 'История пока пуста' : 'No execution history yet'}
        hint={ru
          ? 'Здесь появятся последние запланированные и выполненные автоматизации этого мастера.'
          : 'The latest scheduled and completed automations for this artist will appear here.'}
      />
    );
  }

  return (
    <div className="stack">
      <div className="meta">
        {ru
          ? 'Последние 50 задач. История доступна только для чтения и не показывает адреса получателей, текст писем или ошибки провайдера.'
          : 'Latest 50 jobs. History is read-only and never exposes recipient addresses, message bodies or raw provider errors.'}
      </div>
      {rows.map((row) => (
        <article className="card" key={row.job_id}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <strong>{row.rule_name}</strong>
              <div className="meta">
                {row.client_name}
                {' · '}{appointmentLabel(row.appointment_type, ru)}
                {' · '}{row.message_purpose}
                {' · '}v{row.rule_version}
              </div>
            </div>
            <span className={`badge ${executionBadgeClass(row.lifecycle_status)}`}>
              {executionStatusLabel(row.lifecycle_status, ru)}
            </span>
          </div>
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '4px', margin: '14px 0 0' }}>
            <dt className="meta">{ru ? 'Запланировано' : 'Scheduled for'}</dt>
            <dd style={{ margin: 0 }}>{formatDateTime(row.scheduled_at, ru ? 'ru' : 'en')}</dd>
            <dt className="meta">{ru ? 'Попытки' : 'Attempts'}</dt>
            <dd style={{ margin: 0 }}>{row.attempt_count}</dd>
            {row.failure_reason ? (
              <>
                <dt className="meta">{ru ? 'Причина' : 'Reason'}</dt>
                <dd style={{ margin: 0 }}>{failureReasonLabel(row.failure_reason, ru)}</dd>
              </>
            ) : null}
          </dl>
        </article>
      ))}
    </div>
  );
}

'''
replace_once(page, 'function LifecyclePreviewPanel({\n', history_component + 'function LifecyclePreviewPanel({\n')

history_helpers = '''function executionStatusLabel(status: ClientLifecycleExecutionHistoryRow['lifecycle_status'], ru: boolean): string {
  const labels: Record<ClientLifecycleExecutionHistoryRow['lifecycle_status'], [string, string]> = {
    scheduled: ['Scheduled', 'Запланировано'],
    pending: ['Pending', 'Ожидает'],
    queued: ['Queued', 'В очереди'],
    sent: ['Sent', 'Отправлено'],
    suppressed: ['Suppressed', 'Отправка запрещена'],
    withdrawn: ['Withdrawn', 'Снято'],
    cancelled: ['Cancelled', 'Отменено'],
    failed: ['Failed', 'Ошибка'],
    retrying: ['Retrying', 'Повторная попытка'],
  };
  return labels[status][ru ? 1 : 0];
}

function executionBadgeClass(status: ClientLifecycleExecutionHistoryRow['lifecycle_status']): string {
  if (status === 'sent') return 'ok';
  if (['failed', 'suppressed', 'withdrawn', 'cancelled', 'retrying'].includes(status)) return 'warn';
  return '';
}

function failureReasonLabel(reason: string, ru: boolean): string {
  const labels: Record<string, [string, string]> = {
    client_suppressed: ['Client communications are suppressed', 'Коммуникации с клиентом отключены'],
    appointment_withdrawn: ['Appointment is no longer eligible', 'Запись больше не подходит для отправки'],
    integration_unavailable: ['Email integration is unavailable', 'Email-интеграция недоступна'],
    template_unavailable: ['Active template is unavailable', 'Нет подходящего активного шаблона'],
    destination_unavailable: ['Delivery destination is unavailable', 'Адрес доставки недоступен'],
    email_failed: ['Email preparation failed', 'Не удалось подготовить email'],
    provider_delivery_failed: ['Provider delivery failed', 'Провайдер не доставил сообщение'],
    delivery_state_missing: ['Delivery state could not be confirmed', 'Не удалось подтвердить состояние доставки'],
    automation_failed: ['Automation failed', 'Ошибка автоматизации'],
  };
  return labels[reason]?.[ru ? 1 : 0] ?? (ru ? 'Неизвестная причина' : 'Unknown failure reason');
}

'''
replace_once(page, 'function blockerLabel(blocker: string, ru: boolean): string {\n', history_helpers + 'function blockerLabel(blocker: string, ru: boolean): string {\n')

history_mock = '''    listClientLifecycleExecutionHistory: vi.fn(async () => [{
      job_id: 'job-1',
      rule_id: 'rule-1',
      rule_name: '24 hour reminder',
      rule_version: 1,
      session_id: SESSION_ID,
      client_name: 'History Client',
      appointment_type: 'tattoo_session',
      message_purpose: 'session_reminder_24h',
      scheduled_at: '2026-08-26T10:00:00Z',
      lifecycle_status: 'scheduled',
      job_status: 'pending',
      email_status: null,
      outbox_status: null,
      failure_reason: null,
      attempt_count: 0,
      created_at: '2026-08-25T10:00:00Z',
      updated_at: '2026-08-25T10:00:00Z',
    }]),
'''
replace_once(test, '    previewClientLifecycleRule: vi.fn(async () => ({\n', history_mock + '    previewClientLifecycleRule: vi.fn(async () => ({\n')

replace_once(test,
'''    expect(screen.getByRole('button', { name: 'Show preview' })).toBeInTheDocument();
    expect(screen.getByText('You can view these automations but cannot change them.')).toBeInTheDocument();
''',
'''    expect(screen.getByRole('button', { name: 'Show preview' })).toBeInTheDocument();
    expect(screen.getByText('Execution history')).toBeInTheDocument();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    expect(screen.getByText('History Client')).toBeInTheDocument();
    expect(screen.getByText('You can view these automations but cannot change them.')).toBeInTheDocument();
''')

history_test = '''  it('renders only normalized execution-history failures through the bounded read RPC', async () => {
    const lifecycle = api(false, true);
    lifecycle.listClientLifecycleExecutionHistory.mockResolvedValue([{
      job_id: 'job-failed',
      rule_id: 'rule-1',
      rule_name: '24 hour reminder',
      rule_version: 1,
      session_id: SESSION_ID,
      client_name: 'History Client',
      appointment_type: 'tattoo_session',
      message_purpose: 'session_reminder_24h',
      scheduled_at: '2026-08-26T10:00:00Z',
      lifecycle_status: 'failed',
      job_status: 'completed',
      email_status: 'queued',
      outbox_status: 'dead',
      failure_reason: 'provider_delivery_failed',
      attempt_count: 3,
      created_at: '2026-08-25T10:00:00Z',
      updated_at: '2026-08-26T10:05:00Z',
    }]);
    vi.mocked(useArtistScope).mockReturnValue(artistScope(ARTIST_ID));
    vi.mocked(useApi).mockReturnValue(lifecycle);

    render(<LifecycleAutomationPage />);

    expect(await screen.findByText('Provider delivery failed')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.queryByText('provider_delivery_failed')).not.toBeInTheDocument();
    expect(lifecycle.listClientLifecycleExecutionHistory).toHaveBeenCalledWith(ARTIST_ID);
    expect(lifecycle.createClientLifecycleRule).not.toHaveBeenCalled();
    expect(lifecycle.upsertMessageTemplate).not.toHaveBeenCalled();
    expect(lifecycle.setAutomationRuleEnabled).not.toHaveBeenCalled();
    expect(lifecycle.setMessageTemplateActive).not.toHaveBeenCalled();
  });

'''
replace_once(test, "  it('fails closed when the operator lacks the complete preview capability set', async () => {\n", history_test + "  it('fails closed when the operator lacks the complete preview capability set', async () => {\n")

replace_once(test,
'''    expect(await screen.findByText('Preview unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show preview' })).not.toBeInTheDocument();
''',
'''    expect(await screen.findByText('Preview unavailable')).toBeInTheDocument();
    expect(screen.getByText('History unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show preview' })).not.toBeInTheDocument();
''')

replace_once(test,
'''    await screen.findByRole('button', { name: 'Показать предпросмотр' });
    fireEvent.click(screen.getByRole('button', { name: 'Показать предпросмотр' }));
''',
'''    await screen.findByRole('button', { name: 'Показать предпросмотр' });
    expect(screen.getByText('История выполнения')).toBeInTheDocument();
    expect(screen.getByText('Запланировано')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Показать предпросмотр' }));
''')
