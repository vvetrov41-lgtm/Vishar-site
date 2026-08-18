# Gmail OAuth production diagnostics

The production Gmail OAuth callback exposes only a bounded diagnostic code when connection setup fails. It must never return provider payloads, OAuth codes, access tokens, refresh tokens, client credentials, Supabase secret keys, encryption keys, or mailbox contents.

Allowed callback diagnostic codes:

- `gmail_oauth_code_exchange_failed`
- `gmail_oauth_refresh_token_missing`
- `gmail_oauth_scope_mismatch`
- `gmail_access_token_rejected`
- `gmail_api_error`
- `gmail_profile_identity_invalid`
- `gmail_encryption_key_unavailable`
- `gmail_encryption_key_invalid`
- `gmail_token_store_unavailable`
- `gmail_rpc_forbidden`
- `gmail_rpc_failed`

If an unexpected runtime error is raised, the callback may expose only one of these fixed stage codes:

- `gmail_oauth_code_exchange_failed`
- `gmail_oauth_profile_failed`
- `gmail_oauth_supabase_client_failed`
- `gmail_oauth_token_store_failed`
- `gmail_oauth_supabase_rpc_failed`
- `gmail_oauth_token_cleanup_failed`

The stage value is selected only by backend control flow. Provider payloads and exception text are never interpolated into the response. Errors outside the allow-listed backend codes and fixed stages collapse to `gmail_oauth_failed`.

Production investigation order:

1. Confirm the Google OAuth app is the dedicated Gmail production app and is in the intended publishing state.
2. Confirm Gmail API is enabled for the Google Cloud project that owns the OAuth client.
3. Confirm Worker secret names are present without reading or printing their values.
4. Run a new OAuth attempt and record only the bounded diagnostic code.
5. Check Supabase API logs for `service_set_gmail_integration`. If no call exists for the attempt, the failure occurred before the CRM binding step.
6. Keep `GMAIL_DRAIN_ENABLED=false` until read-only OAuth and Gmail history E2E are proven.

Do not reuse or rotate Calendar credentials while diagnosing Gmail.
