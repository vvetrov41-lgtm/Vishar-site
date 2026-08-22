import { handleMcpRequest } from './lib/mcp-server.js';

export default {
  async fetch(request, env) {
    return handleMcpRequest(request, env);
  },
};
