# Gmail OAuth production diagnostics

The production Gmail OAuth callback exposes only a bounded diagnostic code when connection setup fails. It must never return provider payloads, OAuth codes, access tokens, refresh tokens, client credentials, Supabase secret keys, encryption keys, or mailbox contents.

Allowed callback diagnostic codes:

- `gmail_oauth_code_exchange_failed`
- `gmail_oauth_invalid_client`
- `gmail_oauth_invalid_grant`
- `gmail_oauth_redirect_uri_mismatch`
- `gmail_oauth_invalid_request`
- `gmail_oauth_unauthorized_client`
- `gmail_oauth_deleted_client`
- `gmail_oauth_access_denied`
- `gmail_oauth_invalid_scope`
- `gmail_oauth_unsupported_grant_type`
- `gmail_oauth_temporarily_unavailable`
- `gmail_oauth_server_error`
- `gmail_oauth_token_fetch_failed`
- `gmail_oauth_token_http_400`
- `gmail_oauth_token_http_401`
- `gmail_oauth_token_http_403`
- `gmail_oauth_token_http_429`
- `gmail_oauth_token_http_5xx`
- `gmail_oauth_token_response_invalid`
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

The token endpoint classifier may use only Google OAuth's machine-readable `error` field, bounded HTTP status classes, and local transport stage to select a fixed diagnostic code. It must never expose `error_description`, provider response bodies, authorization codes, or credentials.

A bounded Cloudflare remote-preview probe confirmed the Worker runtime behavior for the Google token endpoint: the default redirect policy and `redirect: "manual"` return an HTTP response, while `redirect: "error"` throws a `TypeError` before a response is available. Google provider calls in the Gmail Worker therefore use `redirect: "manual"`. This preserves explicit redirect handling without automatic redirect following and avoids the Cloudflare runtime failure that previously surfaced as `gmail_oauth_token_fetch_failed`. Do not replace this with automatic redirect following for credential-bearing Google requests.

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
5. For `gmail_oauth_invalid_client` or `gmail_oauth_token_http_401`, verify that the production Worker client ID and client secret belong to the same Web application OAuth client. Never paste the secret into chat or logs.
6. For `gmail_oauth_invalid_grant` or `gmail_oauth_token_http_400`, verify a fresh authorization attempt, the exact redirect URI, and PKCE flow without reusing an authorization code.
7. For `gmail_oauth_token_fetch_failed`, verify the Worker redirect policy remains `manual`, then investigate outbound transport to `https://oauth2.googleapis.com/token` before changing OAuth credentials.
8. Check Supabase API logs for `service_set_gmail_integration`. If no call exists for the attempt, the failure occurred before the CRM binding step.
9. Keep `GMAIL_DRAIN_ENABLED=false` until read-only OAuth and Gmail history E2E are proven.

Do not reuse or rotate Calendar credentials while diagnosing Gmail.
