import { handleMcpRequest } from './lib/mcp-server.js';
import { handlePluginMcpRequest } from './lib/mcp-plugin-server.js';

export default {
  async fetch(request, env) {
    if (env?.MCP_PLUGIN_TOOLS_ENABLED === 'true') return handlePluginMcpRequest(request, env);
    return handleMcpRequest(request, env);
  },
};
