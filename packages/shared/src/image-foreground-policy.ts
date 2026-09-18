import { z } from "zod";

/** Server-created, explicitly disclosed stages. Never accepted from a public job request. */
export const imageForegroundPolicySchema = z.object({
  version: z.literal(1),
  mode: z.enum(["native_transparent", "api_matting"]),
  generationModel: z.string().min(1).max(200),
  mattingModel: z.string().min(1).max(200),
  generationCredits: z.number().int().nonnegative(),
  mattingCredits: z.number().int().nonnegative(),
  totalCredits: z.number().int().nonnegative(),
  pricingVersion: z.literal("credits-v1"),
}).strict().superRefine((value, context) => {
  if (value.totalCredits !== value.generationCredits + value.mattingCredits)
    context.addIssue({ code: "custom", message: "Foreground quote total mismatch" });
  if (value.mode === "native_transparent" && (value.mattingModel !== value.generationModel || value.mattingCredits !== 0))
    context.addIssue({ code: "custom", message: "Native transparency must use the same model in one call" });
});
export type ImageForegroundPolicy = z.infer<typeof imageForegroundPolicySchema>;
