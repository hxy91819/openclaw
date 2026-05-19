---
name: review-pr-all-multi
description: >-
  Run the complete PR review suite in two parallel phases using worker
  subagents. Phase 1 runs review-pr and lightx-review simultaneously.
  Phase 2 runs review-pr-context, review-pr-evidence, review-pr-tests,
  and review-pr-maintainability simultaneously. Merges all outputs into
  a unified .local/review-all.md report.
model: inherit
---

# Review PR All (Multi-Droid Parallel)

Orchestrate the complete PR review suite in two parallel phases for faster
wall-clock time. Each phase spawns worker subagents that invoke existing review
skills. No existing skill files or scripts are modified.

## Inputs

- PR number or URL (required)

## Safety

- Read-only reviews. Never modify product code.
- All work happens in the worktree created by `scripts/pr review-init`.
- Each worker subagent is independent and writes to its own `.local/` output
  files.

## Steps

### 1. Setup worktree

```sh
scripts/pr review-init <PR>
cd .worktrees/pr-<PR>
```

This creates the `.worktrees/pr-<PR>` directory and any PR metadata needed by
the review skills. Run from repo root.

### 2. Phase 1 — General review and deep audit (2 workers in parallel)

Spawn two workers simultaneously using the `Task` tool with
`subagent_type: "worker"`. Each worker invokes its assigned skill via the
`Skill` tool.

**Worker A — review-pr:**

Prompt the worker to:

```
Skill invoke: review-pr
PR: <PR number or URL>
Worktree: .worktrees/pr-<PR>
```

The worker should call `Skill("review-pr")` and follow that skill's procedure.
Output files: `.local/review.json`, `.local/review.md`.

**Worker B — lightx-review:**

Prompt the worker to:

```
Skill invoke: lightx-review
PR: <PR number or URL>
Worktree: .worktrees/pr-<PR>
```

The worker should call `Skill("lightx-review")` and follow that skill's
procedure. Output files: `.local/lightx-review.json`,
`.local/lightx-review.md`.

Wait for both workers to complete before proceeding to Phase 2. Phase 2
reviews need Phase 1 findings as input context.

### 3. Phase 2 — Context, evidence, tests, and maintainability (4 workers in parallel)

Spawn four workers simultaneously using the `Task` tool with
`subagent_type: "worker"`. Each worker invokes its assigned skill via the
`Skill` tool.

**Worker C — review-pr-context:**

Prompt the worker to:

```
Skill invoke: review-pr-context
PR: <PR number or URL>
Worktree: .worktrees/pr-<PR>
Feed findings from .local/review.md and .local/lightx-review.md and any
pre-existing clawsweeper comments into the context analysis.
```

The worker should call `Skill("review-pr-context")` and follow that skill's
procedure. Output files: `.local/context-analysis.json`,
`.local/context-analysis.md`.

**Worker D — review-pr-evidence:**

Prompt the worker to:

```
Skill invoke: review-pr-evidence
PR: <PR number or URL>
Worktree: .worktrees/pr-<PR>
```

The worker should call `Skill("review-pr-evidence")` and follow that skill's
procedure. Output files: `.local/evidence-review.json`,
`.local/evidence-review.md`.

**Worker E — review-pr-tests:**

Prompt the worker to:

```
Skill invoke: review-pr-tests
PR: <PR number or URL>
Worktree: .worktrees/pr-<PR>
```

The worker should call `Skill("review-pr-tests")` and follow that skill's
procedure. If the PR does not touch any test files, skip this review and note
it in the summary. Output files: `.local/test-review.json`,
`.local/test-review.md`.

**Worker F — review-pr-maintainability:**

Prompt the worker to:

```
Skill invoke: review-pr-maintainability
PR: <PR number or URL>
Worktree: .worktrees/pr-<PR>
```

The worker should call `Skill("review-pr-maintainability")` and follow that
skill's procedure. Output files: `.local/maintainability-review.json`,
`.local/maintainability-review.md`.

Wait for all four workers to complete before proceeding to merge.

### 4. Merge results into unified report

Read all output files from `.local/` and produce `.local/review-all.md`:

```markdown
# Unified Review: PR #<N>

## Overall Verdict

| Review                        | Verdict                                    | Risk   |
| ----------------------------- | ------------------------------------------ | ------ |
| General (review-pr)           | <verdict from review.json>                 | —      |
| Deep Audit (lightx-review)    | <verdict from lightx-review.json>          | <risk> |
| Context (review-pr-context)   | —                                          | —      |
| Evidence (review-pr-evidence) | <verdict from evidence-review.json>        | <risk> |
| Tests (review-pr-tests)       | <verdict from test-review.json or SKIPPED> | <risk> |
| Maintainability               | <verdict from maintainability-review.json> | <risk> |

**Combined verdict:** <READY FOR /prepare-pr / NEEDS REVIEW / BLOCKED>

## Context Summary

<from context-analysis.md: domain summary, key concepts at a glance>

## Key Findings

### Blockers

<list blockers from all reviews, or "None">

### Important

<list important findings from all reviews, or "None">

### Nits

<list nits from all reviews, or "None">

## Finding Explanations

<from context-analysis.md: plain-language explanations of each finding with concrete examples>

## Author Test Proof Summary

<from evidence-review.json: expected proof, provided proof level, adequacy, gaps>

## Clawsweeper Follow-up Summary

<from evidence-review.json: clawsweeper comments present, resolved/unresolved status, evidence>

## Design History Summary

<from evidence-review.json: designHistory verdict, confidence, key evidence. Omit section if not_applicable>

## Test Risk Summary

<from test-review.json: assertion delta, mock changes, dynamic verification result; if skipped, say no test files in diff>

## Maintainability Summary

<from maintainability-review.json: dimension scores, coupling/abstraction concerns>

## Recommendation

<1-3 sentence recommendation combining all six reviews>
```

### 5. Print verdict

```sh
cat .local/review-all.md
```

If any review returned BLOCKED, the combined verdict is BLOCKED.

## Guardrails

- Phase 1 must complete before Phase 2 starts. Phase 2 reviews depend on
  Phase 1 findings for context.
- Do not skip lightx-review; it is the only step that enforces full-file
  reads, call-chain tracing, and verified findings via the 8-rubric filter.
- Do not skip review-pr-context; it establishes shared domain understanding
  that downstream reviewers and human readers rely on.
- Do not skip review-pr-evidence; author proof and clawsweeper follow-up live
  in PR metadata, not only the diff.
- Do not treat "no test files in diff" as evidence that testing proof is
  adequate.
- Do not skip review-pr-tests when test files are in the diff.
- Do not skip review-pr-maintainability when core modules or public APIs are
  changed.
- The unified summary references findings by source review to avoid
  duplication.
- Each worker writes to its own output files; there are no write conflicts
  because the output filenames are unique per skill.
