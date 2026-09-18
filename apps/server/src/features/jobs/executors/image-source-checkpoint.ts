import {
  ImageGenerationCheckpointError,
  type ImageGenerationCheckpoint,
  type ProviderImageReference,
} from "./image-generation-checkpoint.js";

export type GeneratedSource = { buffer: Buffer; mimeType: string };

export function createDurableProviderImagePersistence(
  checkpoint: ImageGenerationCheckpoint,
  options: {
    definiteNoResultCodes: ReadonlySet<string>;
    unknownMessage: (detail: string) => string;
  },
) {
  return {
    async getOrCreate(
      invoke: () => Promise<ProviderImageReference>,
    ): Promise<ProviderImageReference> {
      const claim = await checkpoint.claim();
      if (!claim.claimed) {
        if (claim.state.status === "returned") return claim.state.result;
        if (claim.state.status === "calling") {
          throw new ImageGenerationCheckpointError(
            "image_generation_result_unknown",
            options.unknownMessage("上游调用状态未知"),
          );
        }
        throw new ImageGenerationCheckpointError(
          "image_generation_checkpoint_invalid",
          "外部图像结果标记为已归档，但任务绑定的素材不存在；未重复调用供应商。",
        );
      }
      let result: ProviderImageReference;
      try {
        result = await invoke();
      } catch (error) {
        const code = (error as { code?: string })?.code ?? "executor_error";
        if (options.definiteNoResultCodes.has(code)) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new ImageGenerationCheckpointError(
          "image_generation_result_unknown",
          options.unknownMessage(detail),
        );
      }
      await checkpoint.saveReturned(result);
      return result;
    },

    async persistDownloaded(source: GeneratedSource) {
      await checkpoint.saveReturned({
        url: `data:${source.mimeType};base64,${source.buffer.toString("base64")}`,
        mimeType: source.mimeType,
      });
    },
  };
}

/** Provider output is checkpointed before local processing. Retries reuse pixels. */
export async function loadOrGenerateImageSource(options: {
  load: () => Promise<GeneratedSource | null>;
  generate: () => Promise<GeneratedSource>;
  save: (source: GeneratedSource) => Promise<unknown>;
}): Promise<GeneratedSource> {
  const existing = await options.load();
  if (existing) return existing;
  const source = await options.generate();
  await options.save(source);
  return source;
}

/**
 * Durable provider boundary for image generation. The provider reference is
 * persisted before download, and downloaded pixels are persisted back as a
 * bounded data URI before asset storage. Retries therefore only replay safe
 * download/storage/post-processing work.
 */
export async function recoverOrGenerateImageSource(options: {
  checkpoint: ImageGenerationCheckpoint;
  loadArchived: () => Promise<GeneratedSource | null>;
  generate: () => Promise<ProviderImageReference>;
  download: (result: ProviderImageReference) => Promise<GeneratedSource>;
  archive: (source: GeneratedSource) => Promise<unknown>;
}): Promise<GeneratedSource> {
  const claim = await options.checkpoint.claim();
  if (!claim.claimed && claim.state.status === "rejected") {
    throw new ImageGenerationCheckpointError(
      "image_generation_provider_rejected",
      claim.state.errorMessage,
    );
  }
  const archived = await options.loadArchived();
  if (archived) {
    await options.checkpoint.saveArchived(archived.mimeType);
    return archived;
  }
  let reference: ProviderImageReference;
  if (claim.claimed) {
    reference = await options.generate();
    await options.checkpoint.saveReturned(reference);
  } else if (claim.state.status === "returned") {
    reference = claim.state.result;
  } else if (claim.state.status === "calling") {
    throw new ImageGenerationCheckpointError(
      "image_generation_result_unknown",
      "上游生图调用可能已执行，但没有可恢复的返回结果。为避免重复计费，任务已停止；请人工确认供应商结果后再创建新任务。",
    );
  } else {
    throw new ImageGenerationCheckpointError(
      "image_generation_checkpoint_invalid",
      "生图存档标记为已归档，但任务绑定的原图素材不存在；未重复调用生图接口。",
    );
  }

  const source = await options.download(reference);
  const durableReference: ProviderImageReference = {
    url: `data:${source.mimeType};base64,${source.buffer.toString("base64")}`,
    mimeType: source.mimeType,
  };
  // This second returned-state write removes reliance on an expiring or
  // one-shot provider URL while asset storage is retried.
  if (reference.url !== durableReference.url) {
    await options.checkpoint.saveReturned(durableReference);
  }
  await options.archive(source);
  await options.checkpoint.saveArchived(source.mimeType);
  return source;
}
