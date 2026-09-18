import { z } from "zod";
import { createAgentTool } from "./tool-run-context.js";

// Keep the runtime schema local to the server's Zod major version. The same
// closed payload is validated at the shared ContentBlock boundary.
const clarificationToolInputSchema = z.object({
  questions: z.array(z.object({
    title: z.string().trim().min(1).max(60),
    prompt: z.string().trim().min(1).max(500),
    options: z.array(z.string().trim().min(1).max(100)).max(6).default([]),
    allowCustom: z.boolean().default(true),
  }).strict()).min(1).max(4),
}).strict();

/** Produces the authoritative questionnaire payload rendered by the Web app.
 * The tool only pauses for input; it grants no write or payment authority. */
export function createClarificationTool() {
  return createAgentTool({
    id: "ask_clarification",
    description: "Ask one to four necessary user questions in a structured UI, preferably one to three concise questions. Put each question's exact title, prompt and directly relevant answer choices in the same object. Industry choices belong only to industry questions; usage questions need usage choices. Use an empty options list for an open question and allowCustom=true when free text is valid. Do not make optional style, color or background preferences mandatory when a reasonable default is allowed. Call this once instead of writing a numbered questionnaire in prose. This pauses for answers and never authorizes a write, generation or charge.",
    inputSchema: clarificationToolInputSchema,
    execute: async ({ questions }) => ({
      status: "awaiting_user_input" as const,
      questions: questions.map((question, index) => ({
        id: index + 1,
        ...question,
        options: [...new Set(question.options)],
      })),
    }),
  });
}
