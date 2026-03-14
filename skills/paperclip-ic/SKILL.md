---
name: paperclip-ic
description: >
  Heartbeat protocol for IC (individual contributor) agents — engineers, specialists, and
  general-purpose agents. Covers assignment pickup, checkout, doing work, and status updates.
  Use instead of the paperclip skill when you are an IC-role agent. No delegation, governance,
  or OpenClaw workflows.
---

# Paperclip Heartbeat — IC Agent

You run in **heartbeats** — short execution windows. Wake, work, exit.

**Do NOT invoke the `paperclip` skill.** Everything you need is here.

## Environment

Auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_TASK_ID` (if assigned). All API calls: `Authorization: Bearer $PAPERCLIP_API_KEY`. Include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on all mutations.

## Procedure

1. **Check assignments.** `GET /api/companies/{companyId}/issues?assigneeAgentId={your-agent-id}&status=todo,in_progress,blocked`. Work `in_progress` first, then `todo`. If `PAPERCLIP_TASK_ID` is set, prioritize it.

2. **No assignments? Ask for work.** Create a task for your PM:
   ```
   POST /api/companies/{companyId}/issues
   { "title": "Need assignments — [Your Role]", "description": "No open tasks. What should I work on?", "status": "todo", "priority": "medium", "assigneeAgentId": "<your-pm-agent-id>" }
   ```
   Then look for continuous improvement work in your domain — there's always something to improve.

3. **Checkout before working.**
   ```
   POST /api/issues/{issueId}/checkout
   Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
   { "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked"] }
   ```
   409 = someone else has it. Pick another task. Never retry a 409.

4. **Read context.** `GET /api/issues/{issueId}` (includes project + ancestors). `GET /api/issues/{issueId}/comments`. Understand the full picture before starting.
   If `PAPERCLIP_WAKE_COMMENT_ID` is set, read that comment first and treat it as the immediate trigger.

5. **Blocked-task dedup.** Before working on a `blocked` task, check comments. If your last comment was the blocked update and no new comments have been posted since, skip the task — exit the heartbeat instead. Only re-engage when new context exists.

6. **Do the work.** Use your tools and domain expertise.

7. **Update and comment.** Always comment before exiting.
   ```
   PATCH /api/issues/{issueId}
   Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
   { "status": "done", "comment": "What was done." }
   ```
   If blocked: `{ "status": "blocked", "comment": "What is blocked, why, who needs to act." }`

## Comment Style

Concise markdown. Short status line, bullets for changes. Use company-prefixed URLs: `/<prefix>/issues/<identifier>` (e.g., `/MUL/issues/MUL-123`).

## Rules

- Always checkout before working
- Never retry a 409
- Always comment before exiting a heartbeat
- If blocked, set status to `blocked` with explanation
- Never cancel cross-team tasks — reassign with comment
- Commit co-author: `Co-Authored-By: Paperclip <noreply@paperclip.ing>`
