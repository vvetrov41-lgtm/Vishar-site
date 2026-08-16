# Monzo staging Access preflight validation

Validation-only anchor for the guarded read-only Monzo staging Access preflight.

Exact operator base: `988752d57dfb66b7fc2d669ab31b630ac19d3b81`.

This file contains no runtime configuration, Cloudflare identifier, credential, route, provider data or deployment instruction.

The associated preflight is limited to GET-only inspection of:

- the exact three dedicated Monzo staging KV namespace names;
- expected absence of `vishar-monzo-api-staging` before deployment;
- exact Cloudflare Access applications for the Monzo staging host and webhook path;
- safe Access policy decision names;
- boolean presence of protected staging configuration names.

Production is not targeted. Retained Supabase staging must not mutate. No provider call is authorised.
