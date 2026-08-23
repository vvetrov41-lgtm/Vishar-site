# Spec Kit upstream reference

Vishar-site's local spec-driven workflow is based on GitHub Spec Kit `v1.0.0`.

Upstream repository: `github/spec-kit`.

## Intentional local adaptations

This repository does not blindly vendor the full `specify init` output.

The local integration intentionally:

- uses Codex-compatible `.agents/skills/speckit-*/SKILL.md` locations;
- keeps a Vishar-specific constitution and templates;
- routes only substantial work through the full workflow;
- leaves small fixes on existing lightweight Vishar procedures;
- preserves Vishar exact-head, stacked-PR, migration, security, CI, and deployment rules as authoritative;
- does not install Spec Kit shell/PowerShell project scripts;
- does not install `taskstoissues` by default, to avoid creating GitHub issue noise without an explicit workstream decision;
- does not allow specification completion to imply staging or production deployment permission.

## Upgrade rule

Do not replace these files with a newer generated Spec Kit scaffold without review.

When evaluating a future upstream release:

1. compare upstream command semantics with the local `speckit-*` skills;
2. preserve the Vishar constitution unless a project-wide governance change is intended;
3. preserve exact-head and deployment boundaries;
4. review any new scripts, hooks, extensions, or automatic mutations before adoption;
5. update this pin and the integration documentation in the same bounded PR.
