import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../../../supabase/migrations/20260910000011_image_requirement_confirmation.sql",
  import.meta.url,
);

describe("atomic image requirement confirmation migration", () => {
  it("binds exact messages and serializes chat writes with confirmation", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("add column session_sequence bigint");
    expect(sql).toContain("before insert on public.chat_messages");
    expect(sql).toContain("before update or delete on public.chat_messages");
    expect(sql).toContain("where id=new.session_id for update");
    expect(sql).toContain("where id=old.session_id for update");
    expect(sql).toContain("old.role='user'");
    expect(sql).toContain("new.content is distinct from old.content");
    expect(sql).toContain("user_message_content_immutable");
    expect(sql).toContain("add column request_message_id uuid references public.chat_messages(id) on delete set null");
    expect(sql).toContain("add column requirement_message_id uuid references public.chat_messages(id) on delete set null");
    expect(sql).toContain("message.content=run.request_prompt");
    expect(sql).toContain("p_decision='confirm' and not private.loomic_is_image_confirmation_message(current_content)");
    expect(sql).toContain("p_decision='cancel' and not private.loomic_is_image_cancellation_message(current_content)");
    expect(sql).toContain("create function public.loomic_decide_current_image");
    expect(sql).toContain("for update of s");
    expect(sql).toContain("intervening.session_sequence>requirement_sequence");
    const atomicDecision = sql.slice(sql.indexOf("create function public.loomic_decide_current_image"));
    expect(atomicDecision).not.toContain("intervening.session_sequence<=current_sequence");
    expect(sql).not.toContain("update public.agent_runs run set request_message_id");
    expect(sql).toContain("old proposals remain available to their exact ui");
    expect(sql).toContain("confirmation ids, but free-text confirmation must rebuild them");
  });

  it("clears deleted message evidence instead of breaking session deletion", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("old.request_message_id is not null and new.request_message_id is null");
    expect(sql).toContain("new.request_prompt := null");
  });
});
