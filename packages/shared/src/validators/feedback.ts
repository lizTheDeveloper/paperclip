import { z } from "zod";
import {
  FEEDBACK_TARGET_TYPES,
  FEEDBACK_TRACE_STATUSES,
  FEEDBACK_VOTE_VALUES,
} from "../constants.js";

export const feedbackTargetTypeSchema = z.enum(FEEDBACK_TARGET_TYPES);
export const feedbackTraceStatusSchema = z.enum(FEEDBACK_TRACE_STATUSES);
export const feedbackVoteValueSchema = z.enum(FEEDBACK_VOTE_VALUES);

export const upsertIssueFeedbackVoteSchema = z.object({
  targetType: feedbackTargetTypeSchema,
  targetId: z.string().uuid(),
  vote: feedbackVoteValueSchema,
  reason: z.string().trim().max(1000).optional(),
  allowSharing: z.boolean().optional(),
});

export type UpsertIssueFeedbackVote = z.infer<typeof upsertIssueFeedbackVoteSchema>;
