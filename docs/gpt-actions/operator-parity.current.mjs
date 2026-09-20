// Current production-import parity projection.
//
// The large operator-parity.mjs file is a dated CRM snapshot. Keep that history
// immutable and apply narrowly reviewed deltas here until the next full parity
// resnapshot. PR #588 promotes exactly two Research reads from planned to
// available; universal Calendar onboarding adds one Integrations row. Every
// other row is inherited unchanged.

import {
  OPERATOR_PARITY as SNAPSHOT_OPERATOR_PARITY,
  PARITY_METADATA as SNAPSHOT_PARITY_METADATA,
} from './operator-parity.mjs';

const RESEARCH_OVERRIDES = new Map([
  [
    'research.deep_web_search',
    Object.freeze({
      operationId: 'searchWeb',
      contracts: Object.freeze([
        'public.gpt_authorize_web_research',
        'gpt-operations:/v1/web/search',
        'Firecrawl:v2/search',
      ]),
      note: 'Bounded public-web search through the server-owned Firecrawl gateway. Private CRM/client data is forbidden and returned web content is untrusted.',
    }),
  ],
  [
    'research.read_web_page',
    Object.freeze({
      operationId: 'scrapeWebPage',
      contracts: Object.freeze([
        'public.gpt_authorize_web_research',
        'gpt-operations:/v1/web/scrape',
        'Firecrawl:v2/scrape',
      ]),
      note: 'Bounded single-page public-web read through the server-owned Firecrawl gateway with local/private target rejection and untrusted-content marking.',
    }),
  ],
]);

function applyOverride(row) {
  const override = RESEARCH_OVERRIDES.get(row.key);
  if (!override) return row;
  return Object.freeze({
    ...row,
    capabilityDomain: 'Research',
    ui: 'available',
    serverContracts: override.contracts,
    gpt: Object.freeze({ status: 'available', operationId: override.operationId }),
    mcp: 'candidate',
    note: override.note,
  });
}

export const PARITY_METADATA = Object.freeze({
  ...SNAPSHOT_PARITY_METADATA,
  observedAt: '2026-09-04',
  observedRepositoryHead: 'b4e8cc506f9e68d4c5d53647564fd942d6570c8a',
  observedProductionSupabaseMigration: '0136_enquiry_assignee_tenant_scope',
  baselineImportedOperationCount: 68,
  productionCapabilityDomains: Object.freeze([
    ...SNAPSHOT_PARITY_METADATA.productionCapabilityDomains,
    'Research',
  ]),
});

// Universal Calendar onboarding (migration 0137) added one operator action the
// snapshot predates. Connect and disconnect keep their existing `planned` rows:
// they became artist-generic, but they are still browser-bound connector routes
// and still need a reviewed GPT-safe contract before tool exposure.
const ADDED_OPERATIONS = Object.freeze([
  Object.freeze({
    key: 'calendar.connection.reset_account',
    actionDomain: 'Integrations',
    capabilityDomain: 'Integrations',
    capability: 'manage_integrations',
    consequence: 'permission',
    ui: 'provider_handoff',
    serverContracts: Object.freeze(['public.reset_calendar_expected_account']),
    gpt: Object.freeze({ status: 'ui_only', operationId: null }),
    mcp: 'ui_only',
    note: 'Clears the Google account an artist calendar is pinned to so a different account can be authorised. It is only meaningful together with a fresh Google consent the human must complete, and unpinning credential custody must not be an unattended agent action, so it stays a CRM control behind manage_integrations and a disabled integration.',
  }),
]);

function financeGap(key, capability, consequence, serverContracts) {
  return Object.freeze({
    key,
    actionDomain: 'Project Finance',
    capabilityDomain: 'Finance',
    capability,
    consequence,
    ui: 'available',
    serverContracts: Object.freeze(serverContracts),
    gpt: Object.freeze({ status: 'gap', operationId: null }),
    mcp: 'candidate',
    note: 'The CRM now exposes this bounded invoicing action, but no reviewed GPT wrapper exists yet.',
  });
}

// PR #818 adds meaningful operator actions to the CRM UI. They stay explicit
// gaps until a separately reviewed GPT/MCP contract is added; hiding them from
// parity would make the inventory lie even though the transport is unchanged.
const INVOICING_GAPS = Object.freeze([
  financeGap('finance.invoices.list', 'view_finance', 'read', ['public.list_invoices']),
  financeGap('finance.invoices.get', 'view_finance', 'read', ['public.get_invoice']),
  financeGap('finance.invoices.create', 'manage_finance', 'write', ['public.create_invoice']),
  financeGap('finance.invoices.line_item.set', 'manage_finance', 'write', ['public.set_invoice_line_item']),
  financeGap('finance.invoices.line_item.remove', 'manage_finance', 'write', ['public.remove_invoice_line_item']),
  financeGap('finance.invoices.details.set', 'manage_finance', 'write', ['public.set_invoice_details']),
  financeGap('finance.invoices.issue', 'manage_finance', 'money', ['public.issue_invoice']),
  financeGap('finance.invoices.void', 'manage_finance', 'money', ['public.void_invoice']),
  financeGap('finance.invoices.payment_request.attach', 'manage_finance', 'money', ['public.attach_payment_request_to_invoice']),
  financeGap('finance.invoices.payment.record', 'manage_finance', 'money', ['public.record_invoice_payment']),
  financeGap('finance.invoices.credit_note.create', 'manage_finance', 'money', ['public.create_credit_note']),
]);

export const OPERATOR_PARITY = Object.freeze([
  ...SNAPSHOT_OPERATOR_PARITY.map(applyOverride),
  ...ADDED_OPERATIONS,
  ...INVOICING_GAPS,
]);
