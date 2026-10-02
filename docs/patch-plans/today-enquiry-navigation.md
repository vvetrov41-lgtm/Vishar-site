# Today enquiry navigation and client email history

Scope: CRM browser UI only. No schema, provider routing, credentials, messages,
customer data, or public tattoo website changes.

Observed production case: a Gmail reply in Today points at a client-keyed email
screen. Stored outbound messages have enquiry-keyed groups, so the screen does
not find its requested key and skips the live Gmail read.

Patch:

1. Resolve Today reply/email work to an explicitly linked visible enquiry or the
   sole active enquiry for the same artist and client. Ambiguous/missing matches
   open the client card. Preserve attention acknowledgements and other targets.
2. Aggregate client-keyed stored email within one artist, preserving unambiguous
   enquiry/project links. Read the mailbox once through the client route.
3. Allow RLS-visible clients with Gmail-only history to open their mailbox and
   offer this link from their enquiry. No outbox row is required.
4. Cover the reproduced regression, Gmail-only history, ambiguity, artist scope,
   inaccessible clients, and provider-independent Today loading with tests.

Release: exact-head CI, merge to the current product branch, then use the
existing bounded CRM Pages release and read back the deployed release metadata.
Rollback: revert this bounded UI patch and redeploy the previous CRM artifact.
