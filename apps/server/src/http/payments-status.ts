import type { FastifyInstance, FastifyReply } from "fastify";

import { unauthenticatedErrorResponseSchema } from "@loomic/shared";

import type { RequestAuthenticator } from "../supabase/user.js";

/**
 * Whether this installation can take payments at all.
 *
 * The payment routes are only registered when Lemon Squeezy is configured, so the
 * billing page used to answer 404 on `/api/payments/subscription` and tell the user to
 * "try again later" - advice that could never work. This endpoint is registered
 * unconditionally so the console can tell "payments are switched off" apart from
 * "payments are broken", which are different things to show a person.
 */
export async function registerPaymentStatusRoute(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    /** Null when no payment provider is configured for this installation. */
    provider: string | null;
  },
) {
  app.get("/api/payments/status", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return unauthenticated(reply);
    return reply.code(200).send({
      enabled: options.provider !== null,
      provider: options.provider,
    });
  });
}

function unauthenticated(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: { code: "unauthorized", message: "Missing or invalid bearer token." },
    }),
  );
}
