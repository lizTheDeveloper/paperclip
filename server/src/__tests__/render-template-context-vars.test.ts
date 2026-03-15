import { describe, expect, it } from "vitest";
import { renderTemplate } from "@paperclipai/adapter-utils/server-utils";

describe("renderTemplate context vars", () => {
  it("resolves context.wakeReason", () => {
    const result = renderTemplate("Reason: {{context.wakeReason}}", {
      context: { wakeReason: "issue_assigned" },
    });
    expect(result).toBe("Reason: issue_assigned");
  });

  it("resolves context.taskId", () => {
    const result = renderTemplate("Task: {{context.taskId}}", {
      context: { taskId: "abc-123" },
    });
    expect(result).toBe("Task: abc-123");
  });

  it("resolves context.taskTitle and context.taskDescription", () => {
    const result = renderTemplate(
      "Title: {{context.taskTitle}}\nDesc: {{context.taskDescription}}",
      {
        context: {
          taskTitle: "Fix the bug",
          taskDescription: "A short description",
        },
      },
    );
    expect(result).toBe("Title: Fix the bug\nDesc: A short description");
  });

  it("resolves context.assignmentsCount and context.assignments", () => {
    const assignmentsList = "- MUL-1: Task one [todo]\n- MUL-2: Task two [in_progress]";
    const result = renderTemplate(
      "Count: {{context.assignmentsCount}}\n{{context.assignments}}",
      {
        context: {
          assignmentsCount: 2,
          assignments: assignmentsList,
        },
      },
    );
    expect(result).toBe(`Count: 2\n${assignmentsList}`);
  });

  it("resolves context.commentId", () => {
    const result = renderTemplate("Comment: {{context.commentId}}", {
      context: { commentId: "comment-xyz" },
    });
    expect(result).toBe("Comment: comment-xyz");
  });

  it("returns empty string for missing context fields", () => {
    const result = renderTemplate("{{context.taskTitle}}", {
      context: {},
    });
    expect(result).toBe("");
  });

  it("handles full context object with multiple vars", () => {
    const result = renderTemplate(
      "You are woken because: {{context.wakeReason}}. Your current task: {{context.taskTitle}}. You have {{context.assignmentsCount}} assignments.",
      {
        context: {
          wakeReason: "issue_assigned",
          taskTitle: "Build the feature",
          assignmentsCount: 3,
        },
      },
    );
    expect(result).toBe(
      "You are woken because: issue_assigned. Your current task: Build the feature. You have 3 assignments.",
    );
  });
});
