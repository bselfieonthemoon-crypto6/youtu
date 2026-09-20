/**
 * The ONE classification every user-visible failure message comes from.
 *
 * Before this file, a failure reached the user through whichever copy function
 * the calling site happened to import: the canvas placeholder used
 * `canvasFailureLabel`, the chat card used `providerFailureDescription`, and a job
 * with no recognised code fell through to a generic "生成失败". One sentence
 * therefore covered a cancellation, a parameter mistake and a channel-credential
 * problem — three situations that need three different user actions, and two of
 * which are not failures at all. This is the user's own taxonomy, kept
 * deliberately small; the classes are the answer to "what should the user do",
 * not "what did the code call it".
 *
 * The error-code vocabulary is NOT a single union in this repo: codes are minted
 * by the executors, the image/video tools, the grounding path and the catalog
 * resolvers, and consumed by three copy functions. So the mapping below is
 * explicit and `JOB_FAILURE_CLASS_CODES` exposes it, which lets
 * `job-failure-class.test.ts` check that every code the provider copy function
 * knows is classified here. A code that is not listed stays `unknown`.
 *
 * `unknown` is a real answer, not a shrug: an unrecognised code must stay
 * unrecognised. Inventing a cause is the defect this file exists to prevent.
 */
export type JobFailureClass =
  /** The request itself is the problem: bad parameters, or content the channel's
   * policy refuses. The user can fix it and try again. */
  | "user_input"
  /** The Agent planned or proposed something it should not have (a source it
   * could not ground, a model alias it could not identify, a non-standard size
   * without the Skill that authorises it). Retrying the same words fails the same
   * way; the turn needs a different approach or a clarification. */
  | "agent_routing"
  /** Our side: database/API faults, and channel credentials or configuration the
   * platform owns. The user cannot fix it; an administrator must. */
  | "platform"
  /** The image/video channel failed, refused or timed out. Not the user's fault
   * and not ours; a later retry may work. */
  | "provider"
  /** Not a failure. The user (or the system) stopped the job on purpose. */
  | "canceled"
  /** The calling surface does not support this request at all (for example a
   * test/CLI entry that cannot express a value the real UI can). Never presented
   * as a generation failure. */
  | "unsupported_entry"
  /** No recognised cause. Say so; do not guess. */
  | "unknown";

/** User-facing label for each class. Chinese, and deliberately action-shaped. */
export const JOB_FAILURE_CLASS_LABELS: Record<JobFailureClass, string> = {
  user_input: "请求内容需要调整",
  agent_routing: "本次请求没能按预期执行",
  platform: "平台或渠道配置问题",
  provider: "图片/视频渠道失败",
  canceled: "已取消",
  unsupported_entry: "当前入口不支持该请求",
  unknown: "原因未知",
};

const CODE_CLASSES: Record<string, JobFailureClass> = {
  // The rule applied throughout: WHO can fix it. If the user's words or values
  // must change it is `user_input`; if the same words would fail again because the
  // plan/model choice was wrong it is `agent_routing`; if the deployment must be
  // reconfigured it is `platform`; if the upstream service failed it is `provider`.
  // The list was reconciled against every `code:` literal the server mints (the
  // executors, the image/video tools, the catalogs and the canvas writer), because
  // a classifier that silently returns `unknown` for a code the product DOES
  // explain is worse than no classifier.

  // --- user input ---------------------------------------------------------
  // The channel's safety system judged the REQUEST, so the request is what has to
  // change. Classifying it as a provider fault would send the user to "try again".
  invalid_input: "user_input",
  safety_filter: "user_input",
  // The request exceeded a documented limit or named a value the model can be
  // asked for but the turn did not authorise.
  image_prompt_too_long: "user_input",
  image_reference_limit_exceeded: "user_input",
  image_aspect_ratio_invalid: "user_input",
  image_generation_requested_count_unsupported: "user_input",
  image_quality_not_authorized: "user_input",
  image_resolution_not_authorized: "user_input",
  video_reference_limit_exceeded: "user_input",

  // --- provider -----------------------------------------------------------
  provider_rate_limited: "provider",
  provider_rejected: "provider",
  provider_unavailable: "provider",
  provider_quota_insufficient: "provider",
  provider_tool_schema_unsupported: "provider",
  // The upstream timed out with the result unknown: a provider outcome, and the
  // user must not be told to retry automatically.
  image_generation_result_unknown: "provider",
  // The provider returned a frame that does not match the geometry we asked for.
  image_aspect_ratio_mismatch: "provider",
  local_repaint_geometry_mismatch: "provider",
  outpaint_geometry_mismatch: "provider",

  // --- platform -----------------------------------------------------------
  // Channel credentials/configuration belong to the deployment, not to the user
  // and not to the upstream's health: an administrator has to fix them.
  http_401: "platform",
  provider_snapshot_invalid: "platform",
  provider_snapshot_unavailable: "platform",
  provider_snapshot_not_found: "platform",
  provider_snapshot_invalid_request: "platform",
  provider_snapshot_create_failed: "platform",
  provider_snapshot_not_terminal: "platform",
  job_create_failed: "platform",
  job_attempt_increment_failed: "platform",
  agent_context_summary_failed: "platform",
  // Our post-processing and checkpoint plumbing, not the model's output.
  image_postprocess_failed: "platform",
  image_generation_checkpoint_unavailable: "platform",
  image_generation_checkpoint_invalid: "platform",
  // A durable video submission we could not confirm or that our own fence refused.
  video_commit_unknown: "platform",
  video_commit_rejected: "platform",
  // No published video model is a workspace/deployment gap, not a user mistake.
  video_model_unavailable: "platform",

  // --- agent routing ------------------------------------------------------
  // The proposal could not be grounded in the user's own evidence.
  source_grounding_ambiguous: "agent_routing",
  source_grounding_unavailable: "agent_routing",
  source_historical_upload_unavailable: "agent_routing",
  // A model alias that matches more than one catalog entry, or none.
  image_model_identifier_ambiguous: "agent_routing",
  image_model_identifier_unavailable: "agent_routing",
  // An approximate size without this turn's Skill receipt.
  image_approximation_not_authorized: "agent_routing",
  image_nonstandard_size_skill_required: "agent_routing",
  // A ratio the Agent could not resolve from the request.
  image_aspect_ratio_ambiguous: "agent_routing",
  // The chosen tier/model/executor cannot honour the request: retrying the same
  // words picks the same thing again, so the PLAN has to change.
  image_resolution_not_supported: "agent_routing",
  image_execution_tier_invalid: "agent_routing",
  image_legacy_background_removal_contract_required: "agent_routing",
  video_model_required: "agent_routing",
  video_text_to_video_unsupported: "agent_routing",
  video_image_to_video_unsupported: "agent_routing",
  video_duration_unsupported: "agent_routing",
  video_resolution_unsupported: "agent_routing",
  video_audio_unsupported: "agent_routing",
  // A guide asked for an output kind its own manifest does not declare.
  skill_output_kind_conflict: "agent_routing",

  // --- not a failure at all -----------------------------------------------
  // Both mean "stopped on purpose". `job_canceled` is how an executor reports a
  // cancellation mid-flight, so a dead-lettered job can carry it; and a superseded
  // turn keeps its generated image while the attachment is dropped, which its own
  // card copy already states ("图片已生成并保留…未应用到当前画布").
  job_canceled: "canceled",
  agent_task_superseded: "canceled",

  // --- unsupported entry --------------------------------------------------
  // The WebSocket command schema rejected a value the real UI cannot produce
  // either; this is a calling-surface limitation, not a generation failure.
  invalid_command: "unsupported_entry",
};

/** Every code this classifier recognises. Exported so coverage can be asserted. */
export const JOB_FAILURE_CLASS_CODES: readonly string[] = Object.freeze(Object.keys(CODE_CLASSES));

/**
 * Classify one job outcome. `status` outranks `errorCode`: a canceled job is a
 * cancellation even when it carries the code of whatever interrupted it, because
 * "you cancelled this" is the only thing the user needs to read.
 */
export function classifyJobFailure(input: { status?: string | null; errorCode?: string | null }): JobFailureClass {
  if (input.status === "canceled") return "canceled";
  const code = typeof input.errorCode === "string" ? input.errorCode.trim() : "";
  if (!code) return "unknown";
  return CODE_CLASSES[code] ?? "unknown";
}

/** Whether this class is a failure at all. A cancellation is not, and neither is
 * a code the classifier does not recognise well enough to blame anyone for. */
export function isFailureClass(failureClass: JobFailureClass): boolean {
  return failureClass !== "canceled" && failureClass !== "unknown";
}
