import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../../../supabase/migrations/20260911000001_natural_image_confirmation.sql",
  import.meta.url,
);

describe("natural image confirmation migration", () => {
  it("replaces only the shared decision predicate and keeps revision text out of billing authorization", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("create or replace function private.loomic_is_image_confirmation_message");
    expect(sql).toContain("刚才(保存|冻结)的?");
    expect(sql).toContain("raw !~ '[?？]'");
    for (const unsafe of ["如果", "不要", "取消", "尚未", "暂停", "但是", "或者", "再生成", "两张", "多张",
      "改", "换", "调整", "替换", "新增", "删除", "比例", "颜色", "背景", "文案", "文字"])
      expect(sql).toContain(unsafe);
    expect(sql).not.toContain("create or replace function public.loomic_decide_current_image");
    expect(sql).not.toContain("update public.image_generation_proposals");
  });
});
