import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  agents: [] as Array<{ id?: string; instructions?: string }>,
  generates: [] as Array<{ prompt: string; options: any }>,
}));

// Only the model boundary is replaced. The classifier itself stays real, so this
// file proves WHEN an agent/call is created, not merely that one exists.
vi.mock("@mastra/core/agent", () => ({
  Agent: class {
    constructor(options: { id?: string; instructions?: string }) { captured.agents.push(options); }
    async generate(prompt: string, options: any) {
      captured.generates.push({ prompt, options });
      return { object: { intent: "local_edit", reasonCode: "property_edit", confidence: 0.6 } };
    }
  },
}));

import { createDesignTurnIntentClassifier, designTurnIntentClassifierSchema, resolveDesignTurnIntent } from "./design-turn-intent.js";

const CREATE_AND_EDIT = "做一版活动海报，把标题文字改成蓝色";
const CONFIDENT = "做一张活动海报";

function turn(prompt: string, classifier: ReturnType<typeof createDesignTurnIntentClassifier>) {
  return resolveDesignTurnIntent({ prompt, mentions: [], activeSkill: null, hasSeries: false,
    hasAttachments: false, classifier, signal: new AbortController().signal });
}

describe("createDesignTurnIntentClassifier", () => {
  beforeEach(() => { captured.agents = []; captured.generates = []; });

  it("builds no agent and makes no call when no turn needs one", async () => {
    const classifier = createDesignTurnIntentClassifier({} as never);
    expect(captured.agents).toHaveLength(0);
    const resolution = await turn(CONFIDENT, classifier);
    expect(resolution.source).toBe("deterministic");
    expect(captured.agents).toHaveLength(0);
    expect(captured.generates).toHaveLength(0);
  });

  it("builds the agent lazily on the first uncertain turn and reuses it afterwards", async () => {
    const classifier = createDesignTurnIntentClassifier({} as never);
    await turn(CREATE_AND_EDIT, classifier);
    expect(captured.agents).toHaveLength(1);
    expect(captured.agents[0]?.id).toBe("loomic-design-turn-intent");
    await turn(CREATE_AND_EDIT, classifier);
    expect(captured.agents).toHaveLength(1);
    expect(captured.generates).toHaveLength(2);
  });

  it("sends one no-tool structured-output step with the routing schema", async () => {
    const classifier = createDesignTurnIntentClassifier({} as never);
    await turn(CREATE_AND_EDIT, classifier);
    const call = captured.generates[0]!;
    expect(call.options).toMatchObject({
      maxSteps: 1,
      modelSettings: { maxOutputTokens: 200, maxRetries: 0 },
      structuredOutput: { schema: designTurnIntentClassifierSchema, jsonPromptInjection: "system" },
    });
    expect(call.options.abortSignal).toBeInstanceOf(AbortSignal);
    // The prompt must state that this is a routing hint, never authority.
    expect(captured.agents[0]?.instructions).toContain("routing hint");
    expect(captured.agents[0]?.instructions).toContain("never authorizes execution, billing");
    // The request travels as data, with the caller-owned policy version.
    expect(JSON.parse(call.prompt)).toMatchObject({
      policyVersion: "mastra-design-turn-intent-v1", currentRequest: CREATE_AND_EDIT,
    });
  });
});
