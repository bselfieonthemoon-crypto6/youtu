import { describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { createEnvironmentProviders } from "./register-all.js";

describe("environment provider policy", () => {
  it("registers only APIYI even when legacy provider credentials still exist", () => {
    const providers = createEnvironmentProviders({
      apiYiApiBase: "https://api.apiyi.com/v1",
      apiYiApiKey: "apiyi-key",
      googleApiKey: "legacy-google-key",
      googleVertexLocation: "us-central1",
      googleVertexProject: "legacy-project",
      metasoApiKey: "legacy-metaso-key",
      openAIApiKey: "legacy-openai-key",
      replicateApiToken: "legacy-replicate-key",
      volcesApiKey: "legacy-volces-key",
    } as ServerEnv);

    expect(providers.imageProviders.map((provider) => provider.name)).toEqual(["apiyi"]);
    expect(providers.videoProviders.map((provider) => provider.name)).toEqual(["apiyi"]);
    expect(providers.imageProviders[0]?.models.map((model) => model.id)).toEqual([
      "gpt-image-2-all",
      "nano-banana-2",
    ]);
    expect(providers.videoProviders[0]?.models.map((model) => model.id)).toEqual([
      "veo-3.1-fast-generate-preview",
    ]);
  });
});
