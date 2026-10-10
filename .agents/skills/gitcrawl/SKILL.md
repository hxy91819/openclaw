---
name: gitcrawl
description: "GitHub archive: issue/PR search, sync freshness, duplicate clusters, octopool PR status, and Gitcrawl repo work."
metadata:
  openclaw:
    homepage: https://github.com/openclaw/gitcrawl
    requires:
      bins:
        - gitcrawl
        - octopool
    install:
      - kind: go
        module: github.com/openclaw/gitcrawl/cmd/gitcrawl@latest
        bins:
          - gitcrawl
      - kind: go
        module: github.com/openclaw/octopool/cmd/octopool@latest
        bins:
          - octopool
---

# Gitcrawl

Use local GitHub issue/PR archives before live GitHub search. Check freshness first:

```bash
gitcrawl doctor --json
```

Find candidates:

```bash
gitcrawl threads openclaw/openclaw --numbers <issue-or-pr-number> --include-closed --json
gitcrawl neighbors openclaw/openclaw --number <issue-or-pr-number> --limit 12 --json
gitcrawl search issues "query" -R openclaw/openclaw --state open --json number,title,url
gitcrawl clusters openclaw/openclaw --sort size --min-size 5
gitcrawl cluster-detail openclaw/openclaw --id <cluster-id>
```

Hydrate missing PR details/comments before PR triage; check completeness first (rate-limit aware, stops before crossing a reserve floor):

```bash
gitcrawl coverage openclaw/openclaw --json
gitcrawl fill-pr-details openclaw/openclaw --order open-first --include-comments --json
```

For PR status, use octopool (the `gitcrawl gh` shim moved to octopool): use cached archive data first and go live only before mutation/merge decisions:

```bash
octopool gh pr status <number-or-url> -R openclaw/openclaw --compact
octopool gh pr view <number-or-url> -R openclaw/openclaw --json number,title,state,url,isDraft,headRef,headSha
```

Use live `gh` plus checkout proof before commenting, labeling, closing, reopening, merging, or filing a PR review:

```bash
gh pr view <number> --json number,title,state,mergedAt,body,files,comments,reviews,statusCheckRollup
gh issue view <number> --json number,title,state,body,comments,closedAt
```

Report absolute dates, repo names, issue/PR numbers, cluster ids, and source gaps. Do not close/label from similarity alone; require matching intent plus live verification.
