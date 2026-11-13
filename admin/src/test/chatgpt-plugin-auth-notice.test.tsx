import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { App } from '../App';
import { entityLink } from '../pages/NotificationsPage';
import type { CrmNotification } from '../lib/platform-api';
import { renderWithSession } from './fixtures';

describe('ChatGPT Plugin OAuth status in CRM', () => {
  it('shows a reconnection warning only for a verified missing authorization', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: '/integrations',
      chatgptPluginStatus: { connection_state: 'reconnect_required', last_oauth_refresh_at: '2026-11-12T21:00:00Z' },
    });
    const card = await screen.findByTestId('chatgpt-plugin-auth-card');
    expect(card).toHaveAttribute('data-chatgpt-oauth-state', 'reconnect_required');
    expect(within(card).getByRole('alert')).toHaveTextContent('Plugin authorization is no longer confirmed.');
    expect(within(card).getByText(/Last OAuth refresh:/)).toBeInTheDocument();
    expect(rpcCalls.some((call) => call.name === 'refresh_my_chatgpt_plugin_auth_status')).toBe(true);
  });

  it('does not declare the connector broken merely for an old refresh timestamp', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/integrations',
      chatgptPluginStatus: { connection_state: 'authorization_present', last_oauth_refresh_at: '2026-01-01T12:00:00Z' },
    });
    const card = await screen.findByTestId('chatgpt-plugin-auth-card');
    expect(card).toHaveAttribute('data-chatgpt-oauth-state', 'authorization_present');
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(card).getByText(/This is not a live ChatGPT tool test/)).toBeInTheDocument();
  });

  it('does not notify a profile that has never authorized the plugin', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/integrations',
      chatgptPluginStatus: { connection_state: 'not_configured', last_oauth_refresh_at: null },
    });
    await screen.findByRole('heading', { name: 'Forms and websites' });
    expect(screen.queryByTestId('chatgpt-plugin-auth-card')).not.toBeInTheDocument();
  });

  it('keeps the integrations hub available if status inspection fails', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/integrations',
      failRpc: 'refresh_my_chatgpt_plugin_auth_status',
    });
    expect(await screen.findByRole('heading', { name: 'Forms and websites' })).toBeInTheDocument();
    expect(screen.queryByTestId('chatgpt-plugin-auth-card')).not.toBeInTheDocument();
  });

  it('checks OAuth before listing notifications, and links personal notice to integrations', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: '/notifications',
      chatgptPluginStatus: { connection_state: 'reconnect_required', last_oauth_refresh_at: null },
    });
    await screen.findByText('Reply to Charlie');
    const diagnostic = rpcCalls.findIndex((call) => call.name === 'refresh_my_chatgpt_plugin_auth_status');
    const list = rpcCalls.findIndex((call) => call.name === 'list_notifications');
    expect(diagnostic).toBeGreaterThanOrEqual(0);
    expect(list).toBeGreaterThan(diagnostic);

    const notification: Pick<CrmNotification, 'notification_type' | 'entity_type' | 'entity_id'> = {
      notification_type: 'system.chatgpt_reconnect_required', entity_type: null, entity_id: null,
    };
    expect(entityLink(notification as CrmNotification)).toBe('/integrations');
  });
});
