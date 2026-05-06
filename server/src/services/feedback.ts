import type { Db } from "@paperclipai/db";
import type { FeedbackTargetType, FeedbackTraceStatus, FeedbackVoteValue } from "@paperclipai/shared";

export type FeedbackTraceFilter = {
  companyId: string;
  issueId?: string;
  projectId?: string;
  targetType?: FeedbackTargetType;
  vote?: FeedbackVoteValue;
  status?: FeedbackTraceStatus;
  from?: Date;
  to?: Date;
  sharedOnly?: boolean;
  includePayload?: boolean;
};

export function feedbackService(_db: Db) {
  return {
    async listFeedbackTraces(_filter: FeedbackTraceFilter): Promise<unknown[]> {
      // Feedback traces not available in this deployment
      return [];
    },
  };
}
