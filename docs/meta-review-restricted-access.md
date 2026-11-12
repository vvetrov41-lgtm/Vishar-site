# Restricted Meta App Review access

Target: Vishar CRM App Review, existing app `1481226093843982`. This is a
review-only feature. It must not expose production CRM records or WhatsApp
provisioning to the reviewer.

## Current production boundary

The production deployment observed on 2026-11-12 is commit
`d31986772a2536b09a07860f37c75ee88955d59f`. The existing
`business-login.js` requires a Supabase Auth session with an active `owner`
profile, and its Graph readback accepts only configured business
`775640614811667`. The normal WhatsAppConnectionsPage is owner-only for this
review panel. The reviewer cannot repeat this flow without broad CRM access.

## Patch plan

1. Add a standalone review page at an explicit path on the public CRM origin.
   Load no CRM data client, artist memberships, inbox or WhatsApp management
   modules. Its only actions are CRM review sign-in, Meta OAuth and a readback.
2. Authenticate a separate Supabase Auth user whose UUID is bound as a
   production-only `META_REVIEW_CRM_USER_ID`. Do not create a `profiles` row or
   artist membership. The Pages Function validates the Auth user server-side,
   compares its UUID, and checks a review expiry/kill switch.
   Existing owner flow remains unchanged.
3. Introduce a distinct OAuth redirect URI for the review page, with 256-bit
   single-use state, ten-minute expiry, exact origin and URI matching, and
   one-time code exchange. No Meta token is persisted, logged or returned.
4. For reviewer mode, read `/me/permissions` and `/me/businesses`, return only
   a business accessible to the reviewer's Meta identity, and reject the
   production business IDs for Vishar Tattoo Limited and Tattoo Kristina.
   No Graph write or WhatsApp API call is allowed. The owner demo continues
   to use the fixed test business.
5. Create a dedicated CRM Auth user with no profile or memberships. Store its
   temporary sign-in credential only in the Meta reviewer credentials field.
   Never publish it in GitHub, logs or the normal application UI. The reviewer
   uses their own Meta identity; do not share the owner's Facebook credentials.
6. Test positive login and readback, plus denied access to CRM data, all
   WhatsApp mutation endpoints, cross-origin requests, expired state, reused
   code and production business IDs. CI, exact-SHA release and production
   readback must pass before changing Meta reviewer instructions.
7. After review, turn off the server kill switch, revoke the temporary CRM
   account, and remove its UUID binding. Keep the existing owner flow intact.

## Activation gates

- Verify whether a Meta reviewer can authorize a business accessible to their
  own account in the app's review state; do not assume the owner's test
  portfolio is accessible to them.
- Confirm Meta accepts the distinct redirect URI in this existing app.
- Verify the Supabase Auth user has no profile, tenant or artist membership,
  and direct RLS reads return no CRM records.
- Complete the separate Data Handling questionnaire with verified processor
  identities and processing countries. Do not guess these declarations.

The existing App Review draft remains unsubmitted until these gates pass.
