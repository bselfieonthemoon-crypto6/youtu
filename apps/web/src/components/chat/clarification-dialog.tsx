"use client";

import { useEffect, useMemo, useState } from "react";

import { clarificationRequestSchema, type ContentBlock } from "@loomic/shared";
import type { ToolConfirmationKind } from "./tool-block-view";
import { imageProposalDestination } from "../../lib/image-proposal-destination";

export type ClarificationQuestion = {
  id: number;
  title: string;
  prompt: string;
  options: string[];
  allowCustom?: boolean;
};

export type ConfirmationRequest = {
  confirmationId?: string;
  kind?: ToolConfirmationKind;
  title: string;
  prompt: string;
};

export function parseStructuredClarificationQuestions(
  blocks: ContentBlock[],
): ClarificationQuestion[] {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.type !== "clarification") continue;
    return block.questions.map(question => ({
      id: question.id,
      title: question.title,
      prompt: question.prompt,
      options: question.options,
      allowCustom: question.allowCustom,
    }));
  }
  // Compatibility for in-flight messages created by a server version that
  // has emitted the tool result but not yet appended the semantic block.
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.type !== "tool" || block.toolName !== "ask_clarification" || block.status !== "completed") continue;
    const parsed = clarificationRequestSchema.safeParse(block.output);
    if (!parsed.success) return [];
    return parsed.data.questions.map(question => ({
      id: question.id,
      title: question.title,
      prompt: question.prompt,
      options: question.options,
      allowCustom: question.allowCustom,
    }));
  }
  return [];
}

const IMAGE_EXECUTION_TOOLS = new Set([
  "generate_image",
  "edit_image",
  "confirm_image_generation",
]);

/** Keep post-submit suggestions from being promoted into a new questionnaire. */
export function hasImageExecutionReceipt(blocks: ContentBlock[]): boolean {
  return blocks.some((block) => {
    if (block.type !== "tool" || !IMAGE_EXECUTION_TOOLS.has(block.toolName)) {
      return false;
    }
    const output = block.output as Record<string, unknown> | undefined;
    if (block.artifacts?.some((artifact) => artifact.type === "image")) {
      return true;
    }
    if (typeof output?.jobId === "string" && output.jobId.length > 0) {
      return true;
    }
    return [
      "submitting",
      "queued",
      "processing",
      "succeeded",
      "failed",
      "dead_letter",
      "canceled",
    ].includes(String(output?.status));
  });
}

const QUESTION_LINE = /^[ \t]*(\d{1,2})[.、）)][ \t]*(.+)$/;

function questionTitle(prompt: string, index: number) {
  const label = prompt.match(/^([^：:\n？?]{1,32})[：:]/)?.[1]?.trim();
  if (label) return label;
  if (/品牌.*(名称|名字)|名称.*品牌/.test(prompt)) return "品牌名称";
  if (/行业|业务/.test(prompt)) return "所属行业";
  if (/印象|风格|感觉|调性/.test(prompt)) return "品牌风格";
  if (/配色|颜色|色彩/.test(prompt)) return "配色偏好";
  if (/受众|用户|人群/.test(prompt)) return "目标受众";
  return `问题 ${index + 1}`;
}

function questionOptions(title: string, prompt: string) {
  if (/背景|透明/.test(title)) return ["有背景（自动配色）", "透明底", "自动判断"];
  if (/品牌.*(?:名称|名字)/.test(title)) return ["暂未确定", "已有名称（请填写）"];
  if (
    /^(?:用途|使用场景|应用场景|投放场景|使用渠道)$/.test(title) ||
    /App\s*图标|门头|名片|社媒头像/.test(prompt)
  )
    return ["App 图标", "门头 / 招牌", "名片 / 印刷品", "社媒头像"];
  if (/行业|业务|用途/.test(title))
    return ["科技 / 互联网", "电商 / 零售", "文化 / 创意"];
  if (/风格|调性/.test(title)) return ["简约", "科技感", "亲切", "高端", "复古"];
  if (/配色|颜色|色彩/.test(title))
    return ["黑白极简", "蓝紫科技", "暖色活力", "暂未确定"];
  if (title === "目标受众") return ["大众消费者", "年轻用户", "专业人士"];
  if (/logo\s*类型/i.test(title)) return ["只要图形图标", "只要文字", "图标+文字横版组合", "图标+文字竖版组合"];

  const examples = prompt.match(/[（(](?:例如|如)[:：]?\s*([^）)]+)[）)]/)?.[1];
  if (examples) {
    return examples
      .split(/[、，,\/]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 5);
  }
  return ["暂未确定"];
}

/** Parse the complete clarification list, not just entries ending in '?'. */
export function parseClarificationQuestions(
  text: string,
): ClarificationQuestion[] {
  const normalized = text.replace(/\*\*|__/g, "");
  const lines = normalized.split(/\r?\n/);
  const first = lines.findIndex(line => QUESTION_LINE.test(line));
  if (first < 0) return [];
  const intro = lines.slice(0, first).join("\n");
  const prompts: string[] = [];
  let continuation = false;
  for (const line of lines.slice(first)) {
    const match = line.match(QUESTION_LINE);
    if (match) {
      prompts.push(match[2]!.trim());
      continuation = true;
    } else if (!line.trim()) {
      continuation = false;
    } else if (continuation && /^[ \t]+\S/.test(line)) {
      prompts[prompts.length - 1] += `\n${line.trim()}`;
    } else break; // Do not absorb closing prose or a second unrelated list.
  }
  // A single explicit background question can be the only ambiguity left.
  // Never manufacture this question from a statement that an image is transparent.
  if (prompts.length === 1 && /背景|透明/.test(prompts[0]!) && /[？?]/.test(prompts[0]!) && /确认|请问|选择/.test(intro)) {
    return [{ id: 1, title: "背景", prompt: prompts[0]!, options: questionOptions("背景", prompts[0]!) }];
  }
  if (prompts.length < 2) return [];
  const clarificationIntro = /(?:确认|了解|补充|提供|告诉我|询问).{0,30}(?:信息|需求|问题|几点|几项)|(?:回答|请问).{0,20}(?:问题|以下|下面)/s.test(intro);
  if (!clarificationIntro && prompts.filter(prompt => /[？?]/.test(prompt)).length < 2) return [];

  return prompts.map((prompt, index) => {
    const title = questionTitle(prompt, index);
    return {
      id: index + 1,
      title,
      prompt,
      options: questionOptions(title, prompt),
    };
  });
}

/** Detect a settled proposal that explicitly pauses for user confirmation. */
export function parseConfirmationRequest(
  text: string,
): ConfirmationRequest | null {
  const normalized = text.replace(/\*\*/g, "").trim();
  if (!normalized) return null;

  const tail = normalized.slice(-240);
  const asksForConfirmation =
    /等待.{0,12}(?:你的|用户)?确认/.test(tail) ||
    /请.{0,12}确认(?:后|一下|方案|是否)/.test(tail) ||
    /确认后.{0,20}(?:继续|生成|执行|开始)/.test(tail) ||
    /(?:是否|能否|可否).{0,8}确认.{0,24}(?:方案|生成|执行|继续|开始)/.test(
      tail,
    );
  if (!asksForConfirmation) return null;

  const isDesignProposal = /设计(?:构思|思路|方案|计划)|执行计划|方案/.test(
    normalized,
  );
  if (!isDesignProposal) return null;

  return {
    title: "确认设计方案",
    prompt: "方案已经准备好，是否按上述计划继续？",
  };
}

/** Detect a real pending tool proposal even when the model's final prose is truncated. */
export function parseToolConfirmationRequest(
  blocks: ContentBlock[],
): ConfirmationRequest | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.type !== "tool") continue;
    const output = block.output;
    if (!output) continue;
    if (block.toolName === "generate_image") {
      if (output.status !== "awaiting_confirmation") continue;
      const confirmation = output.confirmation;
      if (
        !confirmation ||
        typeof confirmation !== "object" ||
        Array.isArray(confirmation) ||
        typeof (confirmation as Record<string, unknown>).confirmationId !==
          "string"
      ) {
        continue;
      }
      return {
        confirmationId: (confirmation as Record<string, unknown>)
          .confirmationId as string,
        kind: "image_generation",
        title: "确认设计方案",
        prompt: `输出位置：${imageProposalDestination((confirmation as Record<string, unknown>).details)}。是否按此方案生成？`,
      };
    }
    if (
      output.status !== "confirmation_required" ||
      typeof output.confirmation_id !== "string"
    )
      continue;
    if (block.toolName === "apply_design_template")
      return {
        confirmationId: output.confirmation_id,
        kind: "design_template_apply",
        title: "确认套用设计模板",
        prompt: "套用后会替换当前设计场景，是否继续？",
      };
    if (block.toolName === "manipulate_design")
      return {
        confirmationId: output.confirmation_id,
        kind: "design_mutation",
        title: "确认修改设计",
        prompt: "此操作会删除或替换设计内容，是否继续？",
      };
  }
  return null;
}

export function ConfirmationDialog({
  request,
  onClose,
  onConfirmAction,
  onSubmit,
}: {
  request: ConfirmationRequest;
  onClose: () => void;
  onConfirmAction?: () => Promise<{ status: string; message?: string }>;
  onSubmit: (answer: string) => void;
}) {
  const [adjusting, setAdjusting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmationError, setConfirmationError] = useState<string | null>(
    null,
  );

  const handleConfirm = async () => {
    if (!onConfirmAction) {
      onSubmit("确认，请按上述方案继续执行并生成预览。");
      return;
    }
    if (confirming) return;
    setConfirming(true);
    setConfirmationError(null);
    try {
      const result = await onConfirmAction();
      if (result.status === "accepted" || result.status === "applied") {
        onClose();
        return;
      }
      setConfirmationError(result.message ?? "确认失败，请重新发起生成。");
    } catch {
      setConfirmationError("确认失败，请重试。");
    } finally {
      setConfirming(false);
    }
  };

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  return (
    <div
      data-chat-floating-dialog
      className="absolute inset-x-3 bottom-3 z-30"
    >
      <section
        aria-labelledby="confirmation-title"
        className="w-full rounded-2xl border border-black/5 bg-card p-4 shadow-[0_8px_28px_rgba(0,0,0,0.16)] ring-1 ring-black/5"
      >
        <h2
          id="confirmation-title"
          className="text-sm font-semibold text-foreground"
        >
          {request.title}
        </h2>
        <p className="mt-2 text-sm leading-6 text-foreground">
          {request.prompt}
        </p>

        {!adjusting ? (
          <div className="mt-4 space-y-2">
            <button
              type="button"
              disabled={confirming}
              onClick={() => void handleConfirm()}
              className="flex w-full items-center gap-3 rounded-lg border border-foreground bg-foreground px-3 py-2 text-left text-sm text-background"
            >
              <span className="font-medium text-background/70">A</span>
              <span>
                {confirming ? "正在创建生图任务…" : "确认方案，继续生成"}
              </span>
            </button>
            {confirmationError && (
              <p className="text-xs text-destructive" role="alert">
                {confirmationError}
              </p>
            )}
            <button
              type="button"
              onClick={() => setAdjusting(true)}
              className="flex w-full items-center gap-3 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm hover:bg-muted"
            >
              <span className="font-medium text-muted-foreground">B</span>
              <span>需要调整方案</span>
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <textarea
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="请输入需要调整的内容..."
              rows={3}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-foreground"
            />
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={adjusting ? () => setAdjusting(false) : onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted"
          >
            {adjusting ? "返回" : "稍后确认"}
          </button>
          {adjusting && (
            <button
              type="button"
              disabled={!feedback.trim()}
              onClick={() => onSubmit(`需要调整方案：${feedback.trim()}`)}
              className="rounded-lg bg-foreground px-4 py-1.5 text-xs font-medium text-background disabled:opacity-40"
            >
              提交修改
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

type ClarificationDialogProps = {
  questions: ClarificationQuestion[];
  onClose: () => void;
  onSubmit: (answer: string) => void;
};

export function ClarificationDialog({
  questions,
  onClose,
  onSubmit,
}: ClarificationDialogProps) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const question = questions[index] ??
    questions[0] ?? {
      id: 0,
      title: "补充信息",
      prompt: "请补充你的想法。",
      options: [],
    };
  const answer = answers[question.id] ?? "";
  const isLast = index === questions.length - 1;

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  const optionLetters = useMemo(
    () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
    [],
  );
  const finish = () => {
    const response = questions
      .map(
        (item, itemIndex) =>
          `${itemIndex + 1}. ${item.title}：${answers[item.id] || "暂未确定"}`,
      )
      .join("\n");
    onSubmit(response);
  };

  const goNext = () => {
    if (isLast) finish();
    else setIndex((current) => current + 1);
  };

  return (
    <div
      data-chat-floating-dialog
      className="absolute inset-x-3 bottom-3 z-30"
    >
      <section
        aria-labelledby="clarification-title"
        className="m-0 w-full max-w-none rounded-2xl border border-black/5 bg-card p-4 shadow-[0_8px_28px_rgba(0,0,0,0.16)] ring-1 ring-black/5"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2
            id="clarification-title"
            className="text-sm font-semibold text-foreground"
          >
            {question.title}
          </h2>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <button
              type="button"
              aria-label="上一题"
              disabled={index === 0}
              onClick={() => setIndex((current) => current - 1)}
              className="rounded p-1 hover:bg-muted disabled:opacity-30"
            >
              ‹
            </button>
            <span className="tabular-nums text-foreground">
              {index + 1}/{questions.length}
            </span>
            <button
              type="button"
              aria-label="下一题"
              disabled={isLast}
              onClick={() => setIndex((current) => current + 1)}
              className="rounded p-1 hover:bg-muted disabled:opacity-30"
            >
              ›
            </button>
          </div>
        </div>

        <p className="mb-3 text-sm leading-6 text-foreground">
          {question.prompt}
        </p>
        <div className="space-y-2">
          {question.options.map((option, optionIndex) => {
            const selected = answer === option;
            return (
              <button
                key={option}
                type="button"
                onClick={() =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: option,
                  }))
                }
                className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${selected ? "border-foreground bg-foreground text-background" : "border-border bg-background hover:bg-muted"}`}
              >
                <span
                  className={`font-medium ${selected ? "text-background/70" : "text-muted-foreground"}`}
                >
                  {optionLetters[optionIndex]}
                </span>
                <span>{option}</span>
              </button>
            );
          })}
          {question.allowCustom !== false && (
            <label className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2 focus-within:border-foreground">
              <span className="font-medium text-muted-foreground">
                {optionLetters[question.options.length]}
              </span>
              <input
                value={question.options.includes(answer) ? "" : answer}
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" && answer.trim()) goNext();
                }}
                placeholder="输入自定义回答..."
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
              />
            </label>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setAnswers((current) => ({
                ...current,
                [question.id]: "暂未确定",
              }));
              if (isLast) {
                const nextAnswers = { ...answers, [question.id]: "暂未确定" };
                onSubmit(
                  questions
                    .map(
                      (item, itemIndex) =>
                        `${itemIndex + 1}. ${item.title}：${nextAnswers[item.id] || "暂未确定"}`,
                    )
                    .join("\n"),
                );
              } else setIndex((current) => current + 1);
            }}
            className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted"
          >
            跳过
          </button>
          <button
            type="button"
            onClick={goNext}
            className="rounded-lg bg-foreground px-4 py-1.5 text-xs font-medium text-background hover:opacity-90"
          >
            {isLast ? "提交" : "下一个"}
          </button>
        </div>
      </section>
    </div>
  );
}
