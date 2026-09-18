import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../../../supabase/migrations/20260911000008_scoped_image_confirmation.sql",
  import.meta.url,
);

describe("scoped image confirmation migration", () => {
  it("recognizes only a deictic approved scope followed by an other-scope decline", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("create or replace function private.loomic_is_image_confirmation_message");
    expect(sql).toContain("(这个|该|此|上述)");
    expect(sql).toContain("(其他|其余)");
    expect(sql).toContain("暂不执行|先不执行|不执行");
    expect(sql).toContain("raw !~ '[?？]'");
    expect(sql).toContain("concat(scoped[3],scoped[6]) !~");
    for (const unsafe of ["如果", "免费", "取消", "但是", "另外", "同时", "再生成", "批量", "改", "换", "调整", "替换", "新增", "删除"])
      expect(sql).toContain(unsafe);
  });

  it("adds only a guarded proposal-input refusal to the existing atomic decision", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("create function private.loomic_image_confirmation_matches_proposal");
    expect(sql).toContain("approved_scope ~ '(png|jpg|jpeg|webp|透明|去背景|移除背景|删除背景|抠图)'");
    expect(sql).toContain("p_input->>'outputformat'='png'");
    expect(sql).toContain("p_input->>'operation'='remove_background'");
    expect(sql).toContain("pg_get_functiondef('public.loomic_decide_current_image(uuid,uuid,uuid,uuid,text)'::regprocedure)");
    expect(sql).toContain("array_length(string_to_array(definition, old_clause), 1) - 1 <> 1");
    expect(sql).toContain("not private.loomic_image_confirmation_matches_proposal(current_content,proposal.input)");
    expect(sql).not.toContain("create or replace function public.loomic_get_current_image_proposal");
    expect(sql).not.toContain("create or replace function public.loomic_decide_current_image");
    expect(sql).not.toContain("update public.image_generation_proposals");
    expect(sql).not.toContain("insert into public.image_generation_proposals");
    expect(sql).not.toContain("background_jobs");
  });
});
