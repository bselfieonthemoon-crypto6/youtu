-- Server-owned, bounded task authorization. No bearer tokens are stored.
CREATE TABLE public.agent_autonomy_preferences (
 session_id uuid PRIMARY KEY REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
 created_by uuid NOT NULL REFERENCES auth.users(id), enabled boolean NOT NULL
);
ALTER TABLE public.agent_autonomy_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_autonomy_preferences FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_autonomy_preferences FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.agent_autonomy_preferences TO service_role;
CREATE TABLE public.agent_task_autonomy (
 session_id uuid PRIMARY KEY REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
 created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 task_id uuid NOT NULL REFERENCES public.agent_design_tasks(id) ON DELETE CASCADE,
 task_revision bigint NOT NULL, origin_run_id uuid NOT NULL REFERENCES public.agent_runs(id),
 workspace_id uuid NOT NULL REFERENCES public.workspaces(id), canvas_id uuid NOT NULL REFERENCES public.canvases(id),
 enabled boolean NOT NULL DEFAULT true,
 state text NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','running','completed','needs_attention','stopped')),
 rounds integer NOT NULL DEFAULT 0 CHECK(rounds BETWEEN 0 AND 24),
 image_proposals uuid[] NOT NULL DEFAULT '{}',
 claim_token uuid, lease_until timestamptz, internal_run_id uuid,
 last_fingerprint text, outcome jsonb, expires_at timestamptz NOT NULL DEFAULT now()+interval '2 hours',
 next_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(cardinality(image_proposals)<=8), CHECK(outcome IS NULL OR octet_length(outcome::text)<=30000)
);
ALTER TABLE public.agent_task_autonomy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_task_autonomy FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_task_autonomy FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.agent_task_autonomy TO service_role;
CREATE INDEX agent_task_autonomy_due ON public.agent_task_autonomy(next_at) WHERE enabled AND state IN ('waiting','running');

CREATE FUNCTION public.loomic_agent_autonomy(p_action text,p_user uuid,p_session uuid,p_args jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t public.agent_design_tasks; g public.agent_task_autonomy; ws uuid; proposal uuid;
BEGIN
 IF p_action IN ('preference','stop') THEN
   IF NOT EXISTS(SELECT 1 FROM public.chat_sessions s JOIN public.canvases c ON c.id=s.canvas_id
     JOIN public.workspace_members m ON m.workspace_id=c.workspace_id AND m.user_id=p_user
     WHERE s.id=p_session AND s.created_by=p_user) THEN RAISE EXCEPTION 'autonomy_scope_unavailable'; END IF;
   INSERT INTO public.agent_autonomy_preferences(session_id,created_by,enabled)
     VALUES(p_session,p_user,CASE WHEN p_action='stop' THEN false ELSE (p_args->>'enabled')::boolean END)
     ON CONFLICT(session_id) DO UPDATE SET enabled=excluded.enabled;
   IF p_action='preference' THEN RETURN NULL; END IF;
 END IF;
 SELECT * INTO t FROM public.agent_design_tasks WHERE session_id=p_session AND created_by=p_user FOR UPDATE;
 IF NOT FOUND THEN
   IF p_action IN ('status','stop') THEN RETURN NULL; END IF;
   RAISE EXCEPTION 'autonomy_task_unavailable';
 END IF;
 SELECT c.workspace_id INTO ws FROM public.canvases c JOIN public.workspace_members m ON m.workspace_id=c.workspace_id
   WHERE c.id=t.canvas_id AND m.user_id=p_user;
 IF ws IS NULL THEN RAISE EXCEPTION 'autonomy_scope_unavailable'; END IF;
 SELECT * INTO g FROM public.agent_task_autonomy WHERE session_id=p_session AND created_by=p_user FOR UPDATE;
 IF p_action='grant' THEN
   IF (p_args->>'taskId')::uuid IS DISTINCT FROM t.id OR (p_args->>'revision')::bigint IS DISTINCT FROM t.revision
     OR (p_args->>'originRunId')::uuid IS DISTINCT FROM t.current_run_id THEN RAISE EXCEPTION 'autonomy_task_changed'; END IF;
   IF p_args->>'explicit' IS DISTINCT FROM 'true' AND NOT COALESCE(
     (SELECT enabled FROM public.agent_autonomy_preferences WHERE session_id=p_session AND created_by=p_user),
     (p_args->>'defaultEnabled')::boolean,false) THEN RETURN NULL; END IF;
   IF g.task_id=t.id AND g.task_revision=t.revision AND g.origin_run_id=t.current_run_id AND g.enabled AND g.state='running' THEN RETURN to_jsonb(g); END IF;
   -- Automatic enrollment never overrides an explicit user stop. Re-enabling
   -- the same revision also cannot reset already consumed budgets.
   INSERT INTO public.agent_task_autonomy(session_id,created_by,task_id,task_revision,origin_run_id,workspace_id,canvas_id,enabled)
     VALUES(p_session,p_user,t.id,t.revision,t.current_run_id,ws,t.canvas_id,true)
   ON CONFLICT(session_id) DO UPDATE SET task_id=t.id,task_revision=t.revision,origin_run_id=t.current_run_id,
     workspace_id=ws,canvas_id=t.canvas_id,
     enabled=CASE WHEN p_args->>'explicit'='true' THEN true ELSE agent_task_autonomy.enabled END,
     state=CASE WHEN agent_task_autonomy.task_revision<>t.revision OR p_args->>'explicit'='true' THEN 'waiting' ELSE agent_task_autonomy.state END,
     rounds=CASE WHEN agent_task_autonomy.task_revision<>t.revision THEN 0 ELSE agent_task_autonomy.rounds END,
     image_proposals=CASE WHEN agent_task_autonomy.task_revision<>t.revision THEN '{}'::uuid[] ELSE agent_task_autonomy.image_proposals END,
     claim_token=NULL,lease_until=NULL,internal_run_id=NULL,
     last_fingerprint=CASE WHEN agent_task_autonomy.task_revision<>t.revision THEN NULL ELSE agent_task_autonomy.last_fingerprint END,
     expires_at=CASE WHEN agent_task_autonomy.task_revision<>t.revision THEN now()+interval '2 hours' ELSE agent_task_autonomy.expires_at END,
     next_at=now(),updated_at=now();
 ELSIF p_action='stop' THEN
   UPDATE public.agent_task_autonomy SET enabled=false,state='stopped',claim_token=NULL,updated_at=now() WHERE session_id=p_session;
   PERFORM public.loomic_stop_agent_continuations(p_user,p_session);
 ELSIF p_action='status' THEN NULL;
 ELSE
   IF g.session_id IS NULL OR NOT g.enabled OR g.task_id<>t.id OR g.task_revision<>t.revision OR g.origin_run_id<>t.current_run_id
     OR g.expires_at<=now() OR EXISTS(SELECT 1 FROM public.agent_runs WHERE id=g.origin_run_id AND status IN ('failed','canceled')) THEN RETURN NULL; END IF;
   IF p_action='claim' THEN
     IF g.state='running' AND g.lease_until<=now() THEN
       -- Unknown side effects are never blindly repeated after process loss.
       UPDATE public.agent_task_autonomy SET state='needs_attention',outcome='{"reason":"execution_interrupted"}',claim_token=NULL WHERE session_id=p_session;
       RETURN NULL;
     END IF;
     IF g.state<>'waiting' OR g.next_at>now() OR EXISTS(SELECT 1 FROM public.agent_runs WHERE session_id=p_session AND status IN ('accepted','running')) THEN RETURN NULL; END IF;
     UPDATE public.agent_task_autonomy SET state='running',claim_token=extensions.gen_random_uuid(),lease_until=now()+interval '5 minutes',internal_run_id=NULL WHERE session_id=p_session;
   ELSE
     IF g.state<>'running' OR g.claim_token IS DISTINCT FROM (p_args->>'token')::uuid OR g.lease_until<=now() THEN RETURN NULL; END IF;
     IF p_action='active' THEN RETURN to_jsonb(g);
     ELSIF p_action='round' THEN
       IF g.rounds>=24 THEN RAISE EXCEPTION 'autonomy_round_budget_exhausted'; END IF;
       UPDATE public.agent_task_autonomy SET rounds=rounds+1 WHERE session_id=p_session;
     ELSIF p_action='bind' THEN
       IF g.internal_run_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.agent_runs WHERE id=(p_args->>'runId')::uuid) THEN RAISE EXCEPTION 'autonomy_run_already_bound'; END IF;
       UPDATE public.agent_task_autonomy SET internal_run_id=(p_args->>'runId')::uuid WHERE session_id=p_session;
     ELSIF p_action='image' THEN
       proposal:=(p_args->>'proposalId')::uuid;
       IF NOT EXISTS(SELECT 1 FROM public.image_generation_proposals p WHERE p.id=proposal AND p.created_by=p_user
         AND p.session_id=p_session AND p.origin_run_id=t.current_run_id AND p.status IN ('pending','confirmed'))
         THEN RAISE EXCEPTION 'autonomy_proposal_out_of_scope'; END IF;
       IF NOT proposal=ANY(g.image_proposals) THEN
         IF cardinality(g.image_proposals)>=8 THEN RAISE EXCEPTION 'autonomy_image_budget_exhausted'; END IF;
         UPDATE public.agent_task_autonomy SET image_proposals=array_append(image_proposals,proposal) WHERE session_id=p_session;
       END IF;
     ELSIF p_action='finish' THEN
       IF p_args->>'state' NOT IN ('waiting','completed','needs_attention') THEN RAISE EXCEPTION 'autonomy_invalid_state'; END IF;
       UPDATE public.agent_task_autonomy SET state=p_args->>'state',last_fingerprint=COALESCE(p_args->>'fingerprint',last_fingerprint),
         outcome=p_args->'outcome',next_at=now()+interval '5 seconds',claim_token=NULL,lease_until=NULL,updated_at=now() WHERE session_id=p_session;
       IF p_args#>>'{outcome,runId}'=g.internal_run_id::text AND length(p_args#>>'{outcome,content}')>0 THEN
         INSERT INTO public.chat_messages(id,session_id,role,content)
           VALUES(g.internal_run_id,p_session,'assistant',p_args#>>'{outcome,content}') ON CONFLICT(id) DO NOTHING;
       END IF;
     ELSE RAISE EXCEPTION 'autonomy_invalid_action'; END IF;
   END IF;
 END IF;
 SELECT * INTO g FROM public.agent_task_autonomy WHERE session_id=p_session AND created_by=p_user;
 RETURN CASE WHEN g.session_id IS NULL THEN NULL ELSE to_jsonb(g) END;
END $$;
REVOKE ALL ON FUNCTION public.loomic_agent_autonomy(text,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_agent_autonomy(text,uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION private.loomic_supersede_continuations_on_new_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.created_by IS NULL THEN RETURN NEW; END IF;
 PERFORM 1 FROM public.agent_design_tasks WHERE session_id=NEW.session_id AND created_by=NEW.created_by FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 -- Pre-bound server runs are not new user instructions.
 IF EXISTS(SELECT 1 FROM public.agent_task_autonomy WHERE session_id=NEW.session_id AND created_by=NEW.created_by
   AND state='running' AND enabled AND internal_run_id=NEW.id AND lease_until>now()) THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.agent_task_continuations WHERE continuation_run_id=NEW.id AND status='running') THEN
   UPDATE public.agent_task_autonomy SET state='stopped',claim_token=NULL,updated_at=now() WHERE session_id=NEW.session_id AND created_by=NEW.created_by;
 END IF;
 UPDATE public.agent_task_continuations SET status='superseded',completed_at=now(),outcome=jsonb_build_object('reason','new_user_run','runId',NEW.id)
   WHERE session_id=NEW.session_id AND created_by=NEW.created_by AND status IN ('pending','running') AND continuation_run_id IS DISTINCT FROM NEW.id;
 RETURN NEW;
END $$;
