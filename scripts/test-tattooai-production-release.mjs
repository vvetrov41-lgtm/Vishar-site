import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/tattooai-production-release.yml', import.meta.url), 'utf8');

const expectIncludes = (needle, label) => {
  if (!workflow.includes(needle)) throw new Error(`${label}: missing ${needle}`);
};
const expectExcludes = (needle, label) => {
  if (workflow.includes(needle)) throw new Error(`${label}: forbidden ${needle}`);
};

expectIncludes("- 'release/tattooai-production-*'", 'release branch boundary');
expectIncludes("for workflow in 'Static Validation' 'CRM and booking validation'", 'exact-head CI boundary');
expectIncludes('refs/heads/agent/platform-telegram-self-service', 'canonical branch boundary');
expectIncludes('name: crm-production', 'production credential environment');
expectIncludes('secrets.CRM_PRODUCTION_CLOUDFLARE_API_TOKEN', 'scheduled Worker credential');
expectIncludes('secrets.CRM_PRODUCTION_CLOUDFLARE_ACCOUNT_ID', 'scheduled Worker account');
expectExcludes('secrets.CLOUDFLARE_API_TOKEN', 'legacy low-privilege credential');
expectExcludes('secrets.CLOUDFLARE_ACCOUNT_ID', 'legacy low-privilege account');
expectIncludes('test "$(sed -n', 'exact Worker target gate');
expectIncludes('= "tattooai"', 'exact Worker target');
expectIncludes('main = "workers/tattooai-entry.js"', 'exact Worker entrypoint');
expectIncludes('command: deploy --env="" --strict --keep-vars --tag ${{ github.sha }}', 'defensive tagged deploy');
expectIncludes('$api/schedules', 'cron readback');
expectIncludes("config.get('triggers', {}).get('crons', [])", 'cron snapshot comparison');
expectIncludes('bindings.get(\'AI\', {}).get(\'type\') == \'ai\'', 'Workers AI binding readback');
expectIncludes('https://vfjexhfdbrjmuxfdvbdx.supabase.co', 'production Supabase binding');
expectIncludes("endpoint='https://tattooai.vvetrov41.workers.dev/'", 'live Worker boundary');
expectIncludes("-X POST 'https://www.kristinavishar.com/api/booking'", 'live booking adapter boundary');

console.log('TattooAI production release boundaries: passed');
