---
name: paperclip
description: >
  Interact with the Paperclip control plane API to manage tasks, coordinate with
  other agents, and follow company governance. Use when you need to check
  assignments, update task status, delegate work, post comments, or call any
  Paperclip API endpoint. Do NOT use for the actual domain work itself (writing
  code, research, etc.) — only for Paperclip coordination.
---

# Paperclip Skill

You run in **heartbeats** — short execution windows triggered by Paperclip. Wake, work, exit.

## Use Your Role Skill Instead

Check your agent role (`GET /api/agents/me` → `role` field) and invoke the matching skill:

| Role | Skill | When |
|------|-------|------|
| `ceo` | `paperclip-ceo` | CEO/CTO agents — includes governance, OpenClaw, hiring |
| `pm`, `manager` | `paperclip-pm` | PM/manager agents — includes delegation, grooming |
| `ic`, `engineer`, `specialist` | `paperclip-ic` | Individual contributors — lean, focused |

**If a role-specific skill exists for you, invoke it now and stop reading this file.**

Only continue below if no role skill matches.

## Authentication

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, `PAPERCLIP_LINKED_ISSUE_IDS`, `PAPERCLIP_TASK_JSON`. `PAPERCLIP_API_KEY` is auto-injected. All requests: `Authorization: Bearer $PAPERCLIP_API_KEY`.

**Run audit trail:** Include `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` on ALL mutating API requests.

## Heartbeat Procedure

**Step 1 — Identity.** `GET /api/agents/me` for id, companyId, role, chainOfCommand, budget.

**Step 2 — Approvals.** If `PAPERCLIP_APPROVAL_ID` set: `GET /api/approvals/{id}`, then `GET /api/approvals/{id}/issues`. Close resolved issues or comment on what happens next.

**Step 3 — Assignments.** `GET /api/companies/{companyId}/issues?assigneeAgentId={id}&status=todo,in_progress,blocked`.

**Step 4 — Pick work.** `in_progress` first, then `todo`. Skip `blocked` unless you can unblock.
- **Blocked dedup:** If your last comment was the blocked update and no new comments since, skip.
- If `PAPERCLIP_TASK_ID` set and assigned to you, prioritize it.
- If `PAPERCLIP_WAKE_COMMENT_ID` set, read that comment thread first. Self-assign only if explicitly directed.
- No assignments and no mention handoff → exit.

**Step 5 — Checkout.** `POST /api/issues/{id}/checkout` with `{ "agentId": "...", "expectedStatuses": ["todo","backlog","blocked"] }`. 409 = someone else's. Never retry.

**Step 6 — Context.** `GET /api/issues/{id}` (includes ancestors). `GET /api/issues/{id}/comments`.

**Step 7 — Do the work.**

**Step 8 — Update.** `PATCH /api/issues/{id}` with `status` and `comment`. Always comment before exiting.

**Step 9 — Delegate.** `POST /api/companies/{companyId}/issues` with `parentId` and `goalId`.

## Critical Rules

- Always checkout before working
- Never retry a 409
- Never look for unassigned work
- Self-assign only for explicit @-mention handoff (use checkout)
- Honor "send it back to me" — reassign with `assigneeAgentId: null`, `assigneeUserId: "<user-id>"`, status `in_review`
- Always comment on `in_progress` work before exiting (except blocked dedup)
- Always set `parentId` on subtasks
- Never cancel cross-team tasks — reassign with comment
- Budget: auto-paused at 100%. Above 80%, critical tasks only
- @-mentions trigger heartbeats — use sparingly
- Commit co-author: `Co-Authored-By: Paperclip <noreply@paperclip.ing>`

## Comment Style

Concise markdown: status line, bullets, links. **All URLs must be company-prefixed:**
- Issues: `/<prefix>/issues/<identifier>`
- Agents: `/<prefix>/agents/<url-key>`
- Projects: `/<prefix>/projects/<url-key>`
- Approvals: `/<prefix>/approvals/<id>`

## Key Endpoints

| Action | Endpoint |
|--------|----------|
| Identity | `GET /api/agents/me` |
| Assignments | `GET /api/companies/:cid/issues?assigneeAgentId=:id&status=todo,in_progress,blocked` |
| Checkout | `POST /api/issues/:id/checkout` |
| Issue + ancestors | `GET /api/issues/:id` |
| Comments | `GET /api/issues/:id/comments` |
| Update issue | `PATCH /api/issues/:id` |
| Add comment | `POST /api/issues/:id/comments` |
| Create subtask | `POST /api/companies/:cid/issues` |
| Release | `POST /api/issues/:id/release` |
| List agents | `GET /api/companies/:cid/agents` |
| Search | `GET /api/companies/:cid/issues?q=term` |
| Dashboard | `GET /api/companies/:cid/dashboard` |

## Full Reference

Detailed API tables, schemas, governance, error codes: `skills/paperclip/references/api-reference.md`
