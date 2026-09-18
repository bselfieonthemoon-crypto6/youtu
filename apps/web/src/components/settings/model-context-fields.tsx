"use client";

import { useState } from "react";
import { modelContextProfileSchema, type ModelContextProfile } from "@loomic/shared";

export function ModelContextFields({ value, onChange }: {
  value?: ModelContextProfile | null;
  onChange: (profile: ModelContextProfile | null) => void;
}) {
  const [windowSize, setWindowSize] = useState(value?.contextWindowTokens?.toString() ?? "");
  const [inputSize, setInputSize] = useState(value?.maxInputTokens?.toString() ?? "");
  const [outputSize, setOutputSize] = useState(value?.maxOutputTokens?.toString() ?? "");
  const [source, setSource] = useState(value?.profileSource ?? "");
  const [error, setError] = useState("");
  const apply = () => {
    const parsed = modelContextProfileSchema.safeParse({
      contextWindowTokens: Number(windowSize), maxInputTokens: Number(inputSize), maxOutputTokens: Number(outputSize),
      profileSource: source, verifiedAt: new Date().toISOString(), profileVersion: "administrator-v1",
    });
    if (!parsed.success) { setError("请填写有效的 token 限制和验证来源；输入/输出上限不能超过窗口。"); return; }
    setError(""); onChange(parsed.data);
  };
  return <details className="mt-3 rounded-md bg-muted/50 p-2 text-xs">
    <summary className="cursor-pointer">上下文容量：{value ? `${value.contextWindowTokens.toLocaleString()} tokens · 管理员已核实` : "未验证 · 使用保守运行预算"}</summary>
    <p className="my-2 text-muted-foreground">填写当前供应商接口的真实限制，不是模型名称对应的宣传容量。留空不会自动假定支持 128K。</p>
    <div className="grid gap-2 sm:grid-cols-3">
      <label>总窗口 tokens<input aria-label="总上下文窗口 tokens" type="number" value={windowSize} onChange={e => setWindowSize(e.target.value)} className="mt-1 w-full rounded border bg-background p-2" /></label>
      <label>输入上限 tokens<input aria-label="输入上限 tokens" type="number" value={inputSize} onChange={e => setInputSize(e.target.value)} className="mt-1 w-full rounded border bg-background p-2" /></label>
      <label>输出上限 tokens<input aria-label="输出上限 tokens" type="number" value={outputSize} onChange={e => setOutputSize(e.target.value)} className="mt-1 w-full rounded border bg-background p-2" /></label>
    </div>
    <label className="mt-2 block">验证来源<input aria-label="上下文验证来源" value={source} onChange={e => setSource(e.target.value)} placeholder="当前接口文档链接或验证记录" className="mt-1 w-full rounded border bg-background p-2" /></label>
    <div className="mt-2 flex gap-3"><button type="button" onClick={apply} className="rounded border bg-background p-2">确认容量，随供应商设置保存</button>
      {value && <button type="button" onClick={() => { onChange(null); setError(""); }}>恢复未验证状态</button>}</div>
    {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
  </details>;
}
