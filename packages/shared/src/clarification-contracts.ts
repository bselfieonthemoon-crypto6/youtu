import { z } from "zod";

export const clarificationQuestionInputSchema = z.object({
  title: z.string().trim().min(1).max(60),
  prompt: z.string().trim().min(1).max(500),
  options: z.array(z.string().trim().min(1).max(100)).max(6).default([]),
  allowCustom: z.boolean().default(true),
}).strict();

export const clarificationRequestInputSchema = z.object({
  questions: z.array(clarificationQuestionInputSchema).min(1).max(4),
}).strict();

export const clarificationQuestionSchema = clarificationQuestionInputSchema.extend({
  id: z.number().int().positive(),
});

export const clarificationRequestSchema = z.object({
  status: z.literal("awaiting_user_input"),
  questions: z.array(clarificationQuestionSchema).min(1).max(4),
}).strict();

export type ClarificationQuestionData = z.infer<typeof clarificationQuestionSchema>;
export type ClarificationRequestData = z.infer<typeof clarificationRequestSchema>;
