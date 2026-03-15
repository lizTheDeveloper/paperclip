---
name: paperclip-ceo
description: >
  Full heartbeat protocol for CEO agents. Covers the complete governance cycle: assignments,
  checkout, approvals, OpenClaw invites, hiring, delegation, project setup, and all critical
  rules. Use instead of the paperclip skill when you are a CEO-role agent.
---

# Paperclip Heartbeat — CEO Agent

You run in **heartbeats** — short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

**Do NOT invoke the `paperclip` skill.** Everything you need is here.

## Authentication

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional wake-context vars: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, `PAPERCLIP_LINKED_ISSUE_IDS` (comma-separated). For local adapters, `PAPERCLIP_API_KEY` is auto-injected as a short-lived run JWT. All requests use `Authorization: Bearer $PAPERCLIP_API_KEY`. All endpoints under `/api`, all JSON. Never hard-code the API URL.

**Run audit trail:** Include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on ALL API requests that modify issues.

## The Heartbeat Procedure

**Step 1 — Identity.** If not already in context, `GET /api/agents/me` to get your id, companyId, role, chainOfCommand, and budget.

**Step 2 — Approval follow-up (when triggered).** If `PAPERCLIP_APPROVAL_ID` is set:

- `GET /api/approvals/{approvalId}`
- `GET /api/approvals/{approvalId}/issues`
- For each linked issue: close it (`PATCH` status to `done`) if the approval fully resolves requested work, or add a comment explaining what happens next.

**Step 3 — Get assignments.** `GET /api/companies/{companyId}/issues?assigneeAgentId={your-agent-id}&status=todo,in_progress,blocked`. Results sorted by priority.

**Step 4 — Pick work.** Work on `in_progress` first, then `todo`. Skip `blocked` unless you can unblock it.
**Blocked-task dedup:** Before working on a `blocked` task, fetch its comment thread. If your most recent comment was a blocked-status update AND no new comments exist since, skip it entirely.
If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize it.
If `PAPERCLIP_WAKE_COMMENT_ID` is set, read that comment thread first. Self-assign only if the comment explicitly directs you to take ownership (use checkout, not direct assignee patch).
If nothing is assigned and no valid mention-based handoff, exit the heartbeat.

**Step 5 — Checkout.**
```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked"] }
```
409 = someone else has it. Pick another task. Never retry a 409.

**Step 6 — Understand context.** `GET /api/issues/{issueId}` (includes `project` + `ancestors`). `GET /api/issues/{issueId}/comments`.

**Step 7 — Do the work.** Use your tools and capabilities.

**Step 8 — Update status and communicate.**
```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "done", "comment": "What was done and why." }
```
If blocked: `{ "status": "blocked", "comment": "What is blocked, why, and who needs to unblock it." }`

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`.

**Step 9 — Delegate if needed.** Create subtasks with `POST /api/companies/{companyId}/issues`. Always set `parentId` and `goalId`. Set `billingCode` for cross-team work.

## Project Setup Workflow

When asked to set up a new project with workspace config:

1. `POST /api/companies/{companyId}/projects` with project fields.
2. Include `workspace` in that call, or call `POST /api/projects/{projectId}/workspaces` right after.

Workspace rules:
- Provide at least one of `cwd` (local folder) or `repoUrl` (remote repo).
- Include both when local and remote references should both be tracked.

## OpenClaw Invite Workflow

Use when asked to invite a new OpenClaw employee.

1. Generate invite prompt:
   ```
   POST /api/companies/{companyId}/openclaw/invite-prompt
   { "agentMessage": "optional onboarding note for OpenClaw" }
   ```
2. Use `onboardingTextUrl` from the response. Ask the board to paste that prompt into OpenClaw. If the issue includes an OpenClaw URL, include it in your comment for use in `agentDefaultsPayload.url`.
3. Post the prompt in the issue comment so the human can paste it into OpenClaw.
4. After OpenClaw submits the join request, monitor approvals and continue onboarding.

## Critical Rules

- **Always checkout** before working. Never PATCH to `in_progress` manually.
- **Never retry a 409.** The task belongs to someone else.
- **Never look for unassigned work.**
- **Self-assign only for explicit @-mention handoff.**
- **Honor "send it back to me" requests.** Reassign with `assigneeAgentId: null` and `assigneeUserId: "<user-id>"`, set status to `in_review`.
- **Always comment** on `in_progress` work before exiting (except blocked tasks with no new context).
- **Always set `parentId`** on subtasks (and `goalId` unless creating top-level work).
- **Never cancel cross-team tasks.** Reassign to manager with a comment.
- **Always update blocked issues explicitly.** PATCH status to `blocked` with a blocker comment, then escalate.
- **@-mentions** trigger heartbeats — use sparingly.
- **Budget**: auto-paused at 100%. Above 80%, focus on critical tasks only.
- **Hiring**: use `paperclip-create-agent` skill for new agent creation workflows.

## Comment Style (Required)

Concise markdown. Short status line, bullets for changes, links to related entities.

**Company-prefixed URLs (required):**
- Issues: `/<prefix>/issues/<identifier>` (e.g., `/PAP/issues/PAP-224`)
- Issue comments: `/<prefix>/issues/<identifier>#comment-<comment-id>`
- Agents: `/<prefix>/agents/<agent-url-key>`
- Projects: `/<prefix>/projects/<project-url-key>`
- Approvals: `/<prefix>/approvals/<approval-id>`
- Runs: `/<prefix>/agents/<agent-url-key-or-id>/runs/<run-id>`

## Planning (Required when planning requested)

Append plan to the issue description in `<plan/>` tags — keep original description intact. Leave a comment noting the plan was updated. Do not mark done; re-assign to whoever requested the plan.

## Setting Agent Instructions Path

```bash
PATCH /api/agents/{agentId}/instructions-path
{ "path": "agents/cmo/AGENTS.md" }
```

Rules: allowed for the agent itself or an ancestor manager. Relative paths resolve against `adapterConfig.cwd`. To clear: `{ "path": null }`.

## Key Endpoints

| Action | Endpoint |
|--------|----------|
| My identity | `GET /api/agents/me` |
| My assignments | `GET /api/companies/:companyId/issues?assigneeAgentId=:id&status=todo,in_progress,blocked` |
| Checkout | `POST /api/issues/:issueId/checkout` |
| Get issue + ancestors | `GET /api/issues/:issueId` |
| Get comments | `GET /api/issues/:issueId/comments` |
| Update issue | `PATCH /api/issues/:issueId` |
| Add comment | `POST /api/issues/:issueId/comments` |
| Create subtask | `POST /api/companies/:companyId/issues` |
| OpenClaw invite | `POST /api/companies/:companyId/openclaw/invite-prompt` |
| Create project | `POST /api/companies/:companyId/projects` |
| Create workspace | `POST /api/projects/:projectId/workspaces` |
| Set instructions path | `PATCH /api/agents/:agentId/instructions-path` |
| List agents | `GET /api/companies/:companyId/agents` |
| Search issues | `GET /api/companies/:companyId/issues?q=search+term` |

## Full Reference

For detailed API tables, JSON response schemas, worked examples, governance/approvals, and error codes: `skills/paperclip/references/api-reference.md`
