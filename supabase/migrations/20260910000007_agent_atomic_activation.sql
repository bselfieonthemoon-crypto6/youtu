-- Activation and its background enrollment are one commit. A process failure
-- cannot leave a newly activated task without its requested automatic grant.
CREATE FUNCTION public.loomic_agent_task_activate_autonomous(
 p_user uuid,p_session uuid,p_canvas uuid,p_run uuid,p_prompt text,p_target jsonb,
 p_correction_of uuid,p_prepared jsonb,p_default_enabled boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE activated jsonb;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'agent_task_service_role_forbidden'; END IF;
 activated := public.loomic_agent_task_activate(p_user,p_session,p_canvas,p_run,p_prompt,p_target,p_correction_of,p_prepared);
 PERFORM public.loomic_agent_autonomy('grant',p_user,p_session,jsonb_build_object(
   'taskId',activated->>'id','revision',activated->'revision','originRunId',activated->>'runId',
   'explicit',false,'defaultEnabled',p_default_enabled));
 RETURN activated;
END $$;
REVOKE ALL ON FUNCTION public.loomic_agent_task_activate_autonomous(uuid,uuid,uuid,uuid,text,jsonb,uuid,jsonb,boolean)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_agent_task_activate_autonomous(uuid,uuid,uuid,uuid,text,jsonb,uuid,jsonb,boolean) TO service_role;
NOTIFY pgrst,'reload schema';
