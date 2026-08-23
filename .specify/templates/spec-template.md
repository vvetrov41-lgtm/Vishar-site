# Feature Specification: <feature-name>

## Status

- Feature: `<feature-id>`
- State: Draft | Clarified | Planned | In implementation | Converged | Deferred
- Owner/workstream: <owner-or-agent>
- Related PRs/issues: <links-or-none>

## Problem

Describe the user or system problem in observable terms. Do not prescribe implementation here.

## Goals

- <goal>

## Non-goals

- <explicitly-out-of-scope behavior>

## Actors and scope

- User/actor: <who>
- Artist/workspace scope: <scope>
- Environments affected: local | CI | staging | production

## User scenarios

### Scenario 1: <name>

Given <starting state>, when <action>, then <observable result>.

### Scenario 2: <failure or denial case>

Given <starting state>, when <invalid/unauthorized/failing action>, then <observable safe result>.

## Functional requirements

- FR-001: The system MUST <observable behavior>.
- FR-002: The system MUST <observable behavior>.

## Security and trust requirements

- SR-001: <authorization/ownership requirement>
- SR-002: <server-authority requirement>
- SR-003: <secret/provider boundary requirement>

Use `N/A` only when the feature genuinely does not touch a trust boundary.

## Failure and recovery behavior

- <provider failure>
- <retry/idempotency expectations>
- <partial failure behavior>
- <user-visible failure behavior>

## Data and retention expectations

Describe durable records, ownership, deletion/retention, audit evidence, and sensitive-data handling at the behavioral level.

## Acceptance criteria

- AC-001: <specific verifiable outcome>
- AC-002: <specific denial/failure outcome>
- AC-003: <specific compatibility or migration outcome>

## Dependencies and constraints

- <dependency>

## Open questions

- <question, or `None`>

## Requirement changes

Record material scope changes discovered after the first approved draft.

- <date>: <change and reason>
