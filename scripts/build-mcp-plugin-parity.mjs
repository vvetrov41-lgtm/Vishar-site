// Reproducible operation-by-operation inventory for the initial Plugin release.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPluginTools, parseGeneratedYaml } from './build-mcp-plugin-tools.mjs';
import { OPERATOR_PARITY, OWNER_EXTENSIONS } from '../docs/gpt-actions/operator-parity.current.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'docs/plugin-mcp/operation-parity.json');
const byId = new Map(buildPluginTools().map((tool) => [tool.operationId, tool]));
const parityById = new Map(OPERATOR_PARITY.filter((row) => row.gpt.operationId).map((row) => [row.gpt.operationId, row]));
const ownerById = new Map(OWNER_EXTENSIONS.map((row) => [row.operationId, row]));
const schemas = readdirSync(join(root, 'docs/gpt-actions/unified')).filter((file) => /^openapi\..+\.yaml$/.test(file)).sort();
const operations = [];

for (const file of schemas) {
  const doc = parseGeneratedYaml(readFileSync(join(root, 'docs/gpt-actions/unified', file), 'utf8'));
  for (const [path, pathItem] of Object.entries(doc.paths || {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem[method];
      if (!operation?.operationId) continue;
      const id = operation.operationId;
      const tool = byId.get(id);
      const parity = parityById.get(id);
      const owner = ownerById.get(id);
      if (!parity && !owner) throw new Error(`Unclassified GPT operation: ${id}`);
      const excluded = !tool;
      const response = operation.responses?.['200'] || operation.responses?.['201'] || operation.responses?.['202'];
      operations.push({
        operationId: id,
        mcpTool: tool?.name ?? null,
        domain: tool?.domain ?? file.slice('openapi.'.length, -'.yaml'.length),
        description: operation.description || operation.summary || id,
        inputSchema: tool?.definition.inputSchema ?? operation.requestBody?.content?.['application/json']?.schema ?? null,
        outputShape: response?.content?.['application/json']?.schema ?? null,
        outputNote: response?.content?.['application/json']?.schema ? null : 'Legacy Action JSON; exact output schema is not declared in this OpenAPI operation.',
        method: method.toUpperCase(),
        path,
        readWrite: method === 'get' ? 'read' : 'write',
        destructive: tool?.definition.annotations.destructiveHint ?? null,
        permission: parity?.capability ?? (owner ? 'Cloudflare control gate and CRM owner/capability checks' : null),
        scopes: tool ? ['email'] : [],
        handler: parity?.serverContracts ?? (owner ? [owner.gate] : []),
        compatibility: excluded ? 'excluded_initial_release' : 'existing_action_adapter',
        adaptation: excluded ? 'Stage 2 invitation flow and security review' : 'Flatten HTTP path/query/body into MCP arguments; route through the existing GPT Action handler.',
        securityConcern: excluded ? 'Invitation side effect requires separate review' :
          owner ? 'Cloudflare mutation/read boundary requires existing server-side control authorization.' :
          tool.consequence === 'money' ? 'Verify amount, idempotency and actor capability server-side.' :
          tool.consequence === 'provider_send' ? 'External provider side effect; check exact content and retry state.' :
          tool.consequence === 'permission' ? 'Team/workspace authority must come from signed-in membership.' :
          tool.operationId === 'selectArtistContext' ? 'Artist ID allowed only for this membership-checked context switch.' :
          'Active Artist/workspace is derived from the signed-in actor, not tool arguments.',
        sourceSchema: file,
      });
    }
  }
}

const uiOnly = OPERATOR_PARITY.filter((row) => row.gpt.status === 'ui_only').map((row) => ({
  key: row.key, operationId: row.gpt.operationId, status: 'ui_only', reason: row.note,
}));
const ids = new Set(operations.map((row) => row.operationId));
if (ids.size !== operations.length || operations.length !== byId.size) throw new Error('Unified GPT operations and MCP tools differ');
const INVITATIONS = new Set(['inviteArtist', 'inviteStaffMember']);
const stage2 = OPERATOR_PARITY.filter((row) => row.gpt.status === 'implement_now').map((row) => ({
  operationId: row.gpt.operationId, status: 'excluded_initial_release',
  reason: INVITATIONS.has(row.gpt.operationId)
    ? 'Stage 2 invitation flow requires its own security review and is not in the current 13 OpenAPI schemas.'
    : `${row.note} Not in the current 13 OpenAPI schemas.`,
}));
if (stage2.map((row) => row.operationId).sort().join(',') !== 'inviteArtist,inviteStaffMember,setConversationOperatorState,setEnquiryFileClassification,setEnquiryReplyOutsideCrm,updateEnquiryProjectDetails') {
  throw new Error('Unexpected Stage 2 inventory');
}
const report = {
  source: '13 current Unified GPT OpenAPI schemas and operator-parity.current.mjs',
  summary: {
    currentGptOperations: operations.length,
    mcpTools: byId.size,
    semanticParityThroughAdapter: byId.size,
    directHandlerWithoutAdapter: 0,
    requiringActionAdapter: byId.size,
    requiringSchemaChange: 0,
    uiOnly: uiOnly.length,
    excludedCurrentGptOperations: operations.length - byId.size,
    excludedStage2Candidates: stage2.length,
    unresolved: 0,
  },
  operations: operations.sort((a, b) => a.operationId.localeCompare(b.operationId)),
  uiOnly,
  stage2,
};
const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== rendered) throw new Error('Plugin parity report is stale');
} else {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, rendered);
  console.log(JSON.stringify(report.summary));
}
