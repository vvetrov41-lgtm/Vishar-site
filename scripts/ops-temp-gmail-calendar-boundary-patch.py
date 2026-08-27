from pathlib import Path
import re

release = Path('.github/workflows/private-production-release.yml')
observer = Path('.github/workflows/private-production-release-observer.yml')
gmail = Path('.github/workflows/gmail-production-rollout.yml')
orchestrator_test = Path('scripts/test-private-production-release-orchestrator.mjs')
gmail_test = Path('scripts/test-gmail-rollout-phases.mjs')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


release_text = release.read_text()
if "!release/private-crm-rc*-gmail-*" not in release_text:
    release_text = replace_once(
        release_text,
        "      - '!release/private-crm-rc*-backend-auth-*'\n",
        "      - '!release/private-crm-rc*-backend-auth-*'\n"
        "      - '!release/private-crm-rc*-gmail-*'\n"
        "      - '!release/private-crm-rc*-calendar-*'\n",
        'private release trigger exclusions',
    )
    pattern = re.compile(r'(?m)^(\s*)release/private-crm-rc\*\) ;;\s*$')
    matches = list(pattern.finditer(release_text))
    if len(matches) < 4:
        raise SystemExit(f'private release runtime gates: expected >=4 generic gates, found {len(matches)}')
    release_text = pattern.sub(
        lambda m: (
            f"{m.group(1)}release/private-crm-rc*-gmail-*) echo 'Gmail operator refs must use the Gmail-only workflow.' >&2; exit 1 ;;\n"
            f"{m.group(1)}release/private-crm-rc*-calendar-*) echo 'Calendar operator refs must use the Calendar-only workflow.' >&2; exit 1 ;;\n"
            f"{m.group(1)}release/private-crm-rc*) ;;"
        ),
        release_text,
    )
release.write_text(release_text)

observer_text = observer.read_text()
if "!release/private-crm-rc*-gmail-*" not in observer_text:
    observer_text = replace_once(
        observer_text,
        "      - '!release/private-crm-rc*-backend-auth-*'\n",
        "      - '!release/private-crm-rc*-backend-auth-*'\n"
        "      - '!release/private-crm-rc*-gmail-*'\n"
        "      - '!release/private-crm-rc*-calendar-*'\n",
        'private release observer trigger exclusions',
    )
    pattern = re.compile(r'(?m)^(\s*)release/private-crm-rc\*\) ;;\s*$')
    matches = list(pattern.finditer(observer_text))
    if len(matches) != 1:
        raise SystemExit(f'private release observer runtime gate: expected 1 generic gate, found {len(matches)}')
    observer_text = pattern.sub(
        lambda m: (
            f"{m.group(1)}release/private-crm-rc*-gmail-*) exit 1 ;;\n"
            f"{m.group(1)}release/private-crm-rc*-calendar-*) exit 1 ;;\n"
            f"{m.group(1)}release/private-crm-rc*) ;;"
        ),
        observer_text,
    )
observer.write_text(observer_text)

gmail_text = gmail.read_text()
if 'workers/scripts/$GMAIL_WORKER_NAME/settings' not in gmail_text:
    old_pattern = re.compile(
        r'''          api="https://api\.cloudflare\.com/client/v4/accounts/\$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces"\n'''
        r'''          auth=\(-H "Authorization: Bearer \$CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json'\)\n'''
        r'''[\s\S]*?'''
        r'''          echo "tokens_id=\$tokens_id" >> "\$GITHUB_OUTPUT"'''
    )
    matches = list(old_pattern.finditer(gmail_text))
    if len(matches) != 1:
        raise SystemExit(f'Gmail KV resolver: expected exactly one legacy block, found {len(matches)}')
    replacement = '''          auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json')

          if [ "$PHASE" = 'bootstrap' ]; then
            api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces"
            resolve_namespace() {
              local title="$1"
              local listing id created
              listing="$(curl --fail --silent --show-error "${auth[@]}" "$api?per_page=100")"
              id="$(jq -r --arg title "$title" '.result[]? | select(.title == $title) | .id' <<<"$listing")"
              if [ -z "$id" ]; then
                created="$(jq -nc --arg title "$title" '{title:$title}' | curl --fail --silent --show-error "${auth[@]}" -X POST --data-binary @- "$api")"
                jq -e '.success == true' <<<"$created" >/dev/null
                id="$(jq -r '.result.id' <<<"$created")"
              fi
              if ! [[ "$id" =~ ^[0-9a-f]{32}$ ]]; then
                echo "Dedicated Gmail namespace $title is unavailable." >&2
                exit 1
              fi
              printf '%s' "$id"
            }
            state_id="$(resolve_namespace "$GMAIL_STATE_NAMESPACE_TITLE")"
            tokens_id="$(resolve_namespace "$GMAIL_TOKENS_NAMESPACE_TITLE")"
          else
            settings_api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$GMAIL_WORKER_NAME/settings"
            settings="$(curl --fail --silent --show-error "${auth[@]}" "$settings_api")"
            jq -e '.success == true' <<<"$settings" >/dev/null
            resolve_binding() {
              local binding_name="$1"
              local id
              id="$(jq -r --arg name "$binding_name" '.result.bindings[]? | select(.type == "kv_namespace" and .name == $name) | .namespace_id' <<<"$settings")"
              if ! [[ "$id" =~ ^[0-9a-f]{32}$ ]]; then
                echo "Existing Gmail KV binding $binding_name is unavailable." >&2
                exit 1
              fi
              printf '%s' "$id"
            }
            state_id="$(resolve_binding GMAIL_OAUTH_STATE)"
            tokens_id="$(resolve_binding GMAIL_OAUTH_TOKENS)"
          fi

          test "$state_id" != "$tokens_id"
          echo "state_id=$state_id" >> "$GITHUB_OUTPUT"
          echo "tokens_id=$tokens_id" >> "$GITHUB_OUTPUT"'''
    gmail_text = old_pattern.sub(replacement, gmail_text, count=1)
gmail.write_text(gmail_text)

test_text = orchestrator_test.read_text()
if "gmail operator trigger exclusion" not in test_text:
    test_text = replace_once(
        test_text,
        "expectIncludes(workflow, \"- '!release/private-crm-rc*-inventory-*'\", 'read-only inventory trigger exclusion');\n",
        "expectIncludes(workflow, \"- '!release/private-crm-rc*-inventory-*'\", 'read-only inventory trigger exclusion');\n"
        "expectIncludes(workflow, \"- '!release/private-crm-rc*-gmail-*'\", 'gmail operator trigger exclusion');\n"
        "expectIncludes(workflow, \"- '!release/private-crm-rc*-calendar-*'\", 'calendar operator trigger exclusion');\n"
        "expectIncludes(workflow, 'release/private-crm-rc*-gmail-*)', 'gmail operator runtime exclusion');\n"
        "expectIncludes(workflow, 'release/private-crm-rc*-calendar-*)', 'calendar operator runtime exclusion');\n",
        'orchestrator release exclusion assertions',
    )
    test_text = replace_once(
        test_text,
        "expectIncludes(observer, \"- '!release/private-crm-rc*-inventory-*'\", 'release observer inventory exclusion');\n",
        "expectIncludes(observer, \"- '!release/private-crm-rc*-inventory-*'\", 'release observer inventory exclusion');\n"
        "expectIncludes(observer, \"- '!release/private-crm-rc*-gmail-*'\", 'release observer gmail exclusion');\n"
        "expectIncludes(observer, \"- '!release/private-crm-rc*-calendar-*'\", 'release observer calendar exclusion');\n"
        "expectIncludes(observer, 'release/private-crm-rc*-gmail-*)', 'release observer gmail runtime exclusion');\n"
        "expectIncludes(observer, 'release/private-crm-rc*-calendar-*)', 'release observer calendar runtime exclusion');\n",
        'orchestrator observer exclusion assertions',
    )
orchestrator_test.write_text(test_text)

gmail_test_text = gmail_test.read_text()
if 'Existing activated Gmail redeploys must reuse live KV bindings' not in gmail_test_text:
    insertion = '''
const rolloutWorkflow = readFileSync(new URL('../.github/workflows/gmail-production-rollout.yml', import.meta.url), 'utf8');
assert.equal(
  rolloutWorkflow.includes('workers/scripts/$GMAIL_WORKER_NAME/settings'),
  true,
  'Existing activated Gmail redeploys must reuse live KV bindings from Worker settings',
);
assert.equal(
  rolloutWorkflow.includes('.result.bindings[]? | select(.type == "kv_namespace" and .name == $name) | .namespace_id'),
  true,
  'Gmail rollout must resolve existing dedicated KV namespace IDs from live bindings',
);
'''
    marker = "const rootEnv = {\n"
    if marker not in gmail_test_text:
        raise SystemExit('Gmail rollout test insertion marker missing')
    gmail_test_text = gmail_test_text.replace(marker, insertion + '\n' + marker, 1)
gmail_test.write_text(gmail_test_text)
