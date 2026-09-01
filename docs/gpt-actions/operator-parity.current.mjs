// Current production-import parity projection.
//
// The large operator-parity.mjs file is a dated CRM snapshot. Keep that history
// immutable and apply narrowly reviewed deltas here until the next full parity
// resnapshot. PR #588 promotes exactly two Research reads from planned to
// available; every other row is inherited unchanged.

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
  observedAt: '2026-09-01',
  observedRepositoryHead: 'e408ce50890843c7f4ebea72d2ea624d542c29b8',
  observedProductionSupabaseMigration: '0127_vladimir_whatsapp_legacy_connected_backfill',
  baselineImportedOperationCount: 68,
  productionCapabilityDomains: Object.freeze([
    ...SNAPSHOT_PARITY_METADATA.productionCapabilityDomains,
    'Research',
  ]),
});

export const OPERATOR_PARITY = Object.freeze(
  SNAPSHOT_OPERATOR_PARITY.map(applyOverride),
);
