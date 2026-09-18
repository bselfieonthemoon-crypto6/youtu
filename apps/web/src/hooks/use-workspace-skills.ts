"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SkillListItem } from "@loomic/shared";
import { readSkills, skillErrorMessage, subscribeSkillsChanged } from "@/lib/skills-client";

export function useWorkspaceSkills(token: string | undefined) {
  const [state, setState] = useState<{ token?: string; skills: SkillListItem[]; loading: boolean; error: string | null }>({
    skills: [], loading: !!token, error: null,
  });
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const id = ++sequence.current;
    if (!token) { setState({ skills: [], loading: false, error: null }); return; }
    setState((current) => ({ token, skills: current.token === token ? current.skills : [], loading: true, error: null }));
    try {
      const result = await readSkills(token, "workspace");
      if (sequence.current === id) setState({ token, skills: result.skills, loading: false, error: null });
    } catch (error) {
      if (sequence.current === id) setState({ token, skills: [], loading: false,
        error: skillErrorMessage(error, "技能状态加载失败，请重试。") });
    }
  }, [token]);

  useEffect(() => {
    void reload();
    const unsubscribe = subscribeSkillsChanged(() => { void reload(); });
    return () => { sequence.current += 1; unsubscribe(); };
  }, [reload]);

  return { skills: state.token === token ? state.skills : [], loading: state.loading || state.token !== token,
    error: state.token === token ? state.error : null, reload };
}
