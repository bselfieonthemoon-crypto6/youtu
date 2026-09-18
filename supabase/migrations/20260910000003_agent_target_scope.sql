-- Exact multi-board authority derived from the authenticated user request.
-- Workflow plans and model-produced targets are never an authority source.
CREATE TABLE public.agent_task_target_scopes (
  task_id uuid NOT NULL REFERENCES public.agent_design_tasks(id) ON DELETE CASCADE,
  task_revision bigint NOT NULL CHECK (task_revision > 0),
  target_index smallint NOT NULL CHECK (target_index BETWEEN 0 AND 19),
  target jsonb NOT NULL CHECK (jsonb_typeof(target)='object'),
  target_hash text NOT NULL CHECK (char_length(target_hash)=32),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,task_revision,target_index),
  UNIQUE(task_id,task_revision,target_hash)
);
CREATE INDEX agent_task_target_scopes_session_revision
  ON public.agent_task_target_scopes(session_id,task_revision,task_id);
ALTER TABLE public.agent_task_target_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_task_target_scopes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_task_target_scopes FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.loomic_agent_target_subset(p_candidate jsonb,p_authorized jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
BEGIN
  IF jsonb_typeof(p_candidate)<>'object' OR jsonb_typeof(p_authorized)<>'object'
    OR p_candidate->>'kind' IS DISTINCT FROM p_authorized->>'kind' THEN RETURN false; END IF;
  IF p_candidate->>'kind'='canvas_image' THEN
    RETURN p_candidate->>'elementId' IS NOT DISTINCT FROM p_authorized->>'elementId'
      AND p_candidate->>'assetId' IS NOT DISTINCT FROM p_authorized->>'assetId';
  END IF;
  IF p_candidate->>'kind'<>'design' OR p_candidate->>'designId' IS DISTINCT FROM p_authorized->>'designId'
    THEN RETURN false; END IF;
  IF NOT (p_authorized ? 'objectIds') THEN RETURN true; END IF;
  IF NOT (p_candidate ? 'objectIds') OR jsonb_typeof(p_candidate->'objectIds')<>'array' THEN RETURN false; END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p_candidate->'objectIds') candidate_id
    WHERE NOT (p_authorized->'objectIds' ? candidate_id)
  );
END $$;

CREATE FUNCTION private.loomic_agent_task_target_authorized(
  p_task public.agent_design_tasks,
  p_candidate jsonb
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT private.loomic_agent_target_subset(p_candidate,p_task.target)
    OR EXISTS (
      SELECT 1 FROM public.agent_task_target_scopes scope
      WHERE scope.task_id=p_task.id AND scope.task_revision=p_task.revision
        AND scope.created_by=p_task.created_by AND scope.session_id=p_task.session_id
        AND private.loomic_agent_target_subset(p_candidate,scope.target)
    )
$$;

CREATE FUNCTION private.loomic_agent_confirmation_target(p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE candidate jsonb; object_ids jsonb;
BEGIN
  IF jsonb_typeof(p_payload)<>'object' OR COALESCE(p_payload->>'design_id','')
    !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_payload->'commands')<>'array' OR jsonb_array_length(p_payload->'commands')=0
  THEN RETURN NULL; END IF;
  candidate:=jsonb_build_object('kind','design','designId',p_payload->>'design_id');
  -- Any command without an existing object id (including scene/canvas-wide
  -- operations and additions) requires whole-design authority.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'commands') command
    WHERE COALESCE(command->>'object_id','')='') THEN RETURN candidate; END IF;
  SELECT jsonb_agg(value ORDER BY value) INTO object_ids FROM (
    SELECT DISTINCT command->>'object_id' AS value FROM jsonb_array_elements(p_payload->'commands') command
  ) ids;
  RETURN candidate||jsonb_build_object('objectIds',object_ids);
END $$;

CREATE FUNCTION public.loomic_agent_target_scope_activate(
  p_user uuid,p_session uuid,p_run uuid,p_task_revision bigint,p_targets jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  task public.agent_design_tasks;
  origin_canvas public.canvases;
  candidate jsonb;
  target_index integer;
  design_id_text text;
  object_value jsonb;
  destination_key text;
  destination_keys text[] := ARRAY[]::text[];
  primary_present boolean := false;
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  task:=private.loomic_agent_task_lock(p_run);
  IF task.id IS NULL OR task.created_by IS DISTINCT FROM p_user OR task.session_id IS DISTINCT FROM p_session
    THEN RAISE EXCEPTION 'agent_target_scope_forbidden'; END IF;
  IF task.revision IS DISTINCT FROM p_task_revision THEN RAISE EXCEPTION 'agent_target_scope_revision_conflict'; END IF;
  IF jsonb_typeof(p_targets)<>'array' OR jsonb_array_length(p_targets) NOT BETWEEN 1 AND 20
    THEN RAISE EXCEPTION 'agent_target_scope_invalid'; END IF;
  SELECT * INTO origin_canvas FROM public.canvases WHERE id=task.canvas_id FOR SHARE;
  IF origin_canvas.id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.workspace_members member
    WHERE member.workspace_id=origin_canvas.workspace_id AND member.user_id=p_user
      AND member.role IN ('owner','admin')
  ) THEN RAISE EXCEPTION 'agent_target_scope_forbidden'; END IF;

  -- A revision's scope is immutable. Retrying an identical activation is safe;
  -- a second caller cannot broaden it even with service-role access.
  IF EXISTS (SELECT 1 FROM public.agent_task_target_scopes WHERE task_id=task.id AND task_revision=task.revision) THEN
    IF (SELECT count(*) FROM public.agent_task_target_scopes WHERE task_id=task.id AND task_revision=task.revision)
        <> jsonb_array_length(p_targets)
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_targets) WITH ORDINALITY input(target,ordinal)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.agent_task_target_scopes stored
          WHERE stored.task_id=task.id AND stored.task_revision=task.revision
            AND stored.target_index=input.ordinal-1 AND stored.target=input.target
        )
      )
    THEN RAISE EXCEPTION 'agent_target_scope_conflict'; END IF;
    RETURN p_targets;
  END IF;

  FOR candidate,target_index IN
    SELECT value,(ordinality-1)::integer FROM jsonb_array_elements(p_targets) WITH ORDINALITY
  LOOP
    IF jsonb_typeof(candidate)<>'object' OR COALESCE(candidate->>'kind','') NOT IN ('design','canvas_image')
      THEN RAISE EXCEPTION 'agent_target_scope_invalid'; END IF;
    -- Object-id arrays are sets for authorization purposes; request ordering must
    -- not make an otherwise exact primary target impossible to activate.
    primary_present:=primary_present OR (
      private.loomic_agent_target_subset(candidate,task.target)
      AND private.loomic_agent_target_subset(task.target,candidate)
      AND COALESCE(candidate->>'elementId','')=COALESCE(task.target->>'elementId','')
    );
    IF candidate->>'kind'='design' THEN
      IF NOT (candidate ? 'designId')
        OR EXISTS (SELECT 1 FROM jsonb_object_keys(candidate) key WHERE key NOT IN ('kind','designId','objectIds','elementId'))
        OR jsonb_typeof(candidate->'designId')<>'string'
        OR candidate->>'designId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (candidate ? 'elementId' AND (jsonb_typeof(candidate->'elementId')<>'string'
          OR char_length(candidate->>'elementId') NOT BETWEEN 1 AND 200))
      THEN RAISE EXCEPTION 'agent_target_scope_invalid'; END IF;
      design_id_text:=candidate->>'designId';
      destination_key:='design:'||design_id_text;
      IF destination_key=ANY(destination_keys) THEN RAISE EXCEPTION 'agent_target_scope_duplicate'; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.design_documents design
        JOIN public.design_nodes node ON node.design_id=design.id AND node.workspace_id=design.workspace_id AND node.deleted_at IS NULL
        JOIN public.canvases target_canvas ON target_canvas.id=node.canvas_id AND target_canvas.workspace_id=node.workspace_id
        WHERE design.id=design_id_text::uuid AND design.deleted_at IS NULL
          AND design.workspace_id=origin_canvas.workspace_id AND design.project_id=origin_canvas.project_id
          AND target_canvas.project_id=origin_canvas.project_id
          AND (NOT (candidate ? 'elementId') OR node.element_id=candidate->>'elementId')
      ) THEN RAISE EXCEPTION 'agent_target_scope_forbidden'; END IF;
      IF candidate ? 'objectIds' THEN
        IF jsonb_typeof(candidate->'objectIds')<>'array' OR jsonb_array_length(candidate->'objectIds') NOT BETWEEN 1 AND 100
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(candidate->'objectIds') value
            WHERE jsonb_typeof(value)<>'string' OR trim(both '"' from value::text) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
          OR (SELECT count(*) FROM jsonb_array_elements_text(candidate->'objectIds'))
            <> (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(candidate->'objectIds') value)
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(candidate->'objectIds') requested(object_id)
            WHERE NOT EXISTS (
              SELECT 1 FROM public.design_documents design,jsonb_array_elements(design.scene->'objects') object
              WHERE design.id=design_id_text::uuid AND design.deleted_at IS NULL
                AND object->>'objectId'=requested.object_id
            )
          )
        THEN RAISE EXCEPTION 'agent_target_scope_forbidden'; END IF;
      END IF;
    ELSE
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(candidate) key WHERE key NOT IN ('kind','elementId','assetId'))
        OR NOT (candidate ?& ARRAY['elementId','assetId'])
        OR jsonb_typeof(candidate->'elementId')<>'string' OR char_length(candidate->>'elementId') NOT BETWEEN 1 AND 200
        OR jsonb_typeof(candidate->'assetId')<>'string'
        OR candidate->>'assetId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN RAISE EXCEPTION 'agent_target_scope_invalid'; END IF;
      destination_key:='canvas_image:'||(candidate->>'elementId');
      IF destination_key=ANY(destination_keys) THEN RAISE EXCEPTION 'agent_target_scope_duplicate'; END IF;
      SELECT element INTO object_value FROM jsonb_array_elements(COALESCE(origin_canvas.content->'elements','[]'::jsonb)) element
        WHERE element->>'id'=candidate->>'elementId' AND element->>'type'='image'
          AND COALESCE((element->>'isDeleted')::boolean,false)=false;
      IF object_value IS NULL OR COALESCE(
        origin_canvas.content->'files'->(object_value->>'fileId')->>'assetId',object_value#>>'{customData,assetId}'
      ) IS DISTINCT FROM candidate->>'assetId' THEN RAISE EXCEPTION 'agent_target_scope_forbidden'; END IF;
    END IF;
    destination_keys:=array_append(destination_keys,destination_key);
  END LOOP;
  IF NOT primary_present THEN RAISE EXCEPTION 'agent_target_scope_primary_missing'; END IF;

  INSERT INTO public.agent_task_target_scopes(task_id,task_revision,target_index,target,target_hash,created_by,session_id)
    SELECT task.id,task.revision,(ordinality-1)::smallint,value,md5(value::text),task.created_by,task.session_id
    FROM jsonb_array_elements(p_targets) WITH ORDINALITY;
  RETURN p_targets;
END $$;

CREATE FUNCTION public.loomic_agent_target_scope_list(
  p_user uuid,p_session uuid,p_run uuid,p_task_revision bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task public.agent_design_tasks; targets jsonb;
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  task:=private.loomic_agent_task_lock(p_run);
  IF task.id IS NULL OR task.created_by IS DISTINCT FROM p_user OR task.session_id IS DISTINCT FROM p_session
    THEN RAISE EXCEPTION 'agent_target_scope_forbidden'; END IF;
  IF task.revision IS DISTINCT FROM p_task_revision THEN RAISE EXCEPTION 'agent_target_scope_revision_conflict'; END IF;
  SELECT jsonb_agg(target ORDER BY target_index) INTO targets FROM public.agent_task_target_scopes
    WHERE task_id=task.id AND task_revision=task.revision AND created_by=p_user AND session_id=p_session;
  RETURN COALESCE(targets,jsonb_build_array(task.target));
END $$;

CREATE FUNCTION public.loomic_agent_target_scope_assert(
  p_user uuid,p_session uuid,p_run uuid,p_task_revision bigint,p_target jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task public.agent_design_tasks;
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  task:=private.loomic_agent_task_lock(p_run);
  IF task.id IS NULL OR task.created_by IS DISTINCT FROM p_user OR task.session_id IS DISTINCT FROM p_session
    OR task.revision IS DISTINCT FROM p_task_revision THEN RETURN false; END IF;
  RETURN private.loomic_agent_task_target_authorized(task,p_target);
END $$;

-- Background image submissions remain tied to the current task revision and
-- must resolve to the primary target or an authenticated-request scope row.
CREATE OR REPLACE FUNCTION private.loomic_agent_task_bind_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE origin uuid; task public.agent_design_tasks; candidate jsonb; object_id text; BEGIN
  IF TG_OP='UPDATE' THEN
    IF EXISTS (SELECT 1 FROM public.agent_design_task_jobs WHERE job_id=OLD.id)
      AND (NEW.payload IS DISTINCT FROM OLD.payload OR NEW.created_by IS DISTINCT FROM OLD.created_by
        OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.canvas_id IS DISTINCT FROM OLD.canvas_id
        OR NEW.design_id IS DISTINCT FROM OLD.design_id OR NEW.target_kind IS DISTINCT FROM OLD.target_kind) THEN
      RAISE EXCEPTION 'agent_task_job_immutable';
    END IF;
    IF NEW.credits_cost IS DISTINCT FROM OLD.credits_cost OR NEW.image_enqueued_at IS DISTINCT FROM OLD.image_enqueued_at THEN
      SELECT run_id INTO origin FROM public.agent_design_task_jobs WHERE job_id=OLD.id;
      PERFORM private.loomic_agent_task_lock(origin);
    END IF;
    RETURN NEW;
  END IF;
  SELECT origin_run_id INTO origin FROM public.image_generation_proposals WHERE id=NEW.id;
  IF origin IS NULL AND NEW.payload->>'origin_run_id' IS NOT NULL THEN origin:=(NEW.payload->>'origin_run_id')::uuid; END IF;
  task:=private.loomic_agent_task_lock(origin);
  IF task.id IS NULL THEN RETURN NEW; END IF;
  IF NEW.created_by IS DISTINCT FROM task.created_by OR NEW.session_id IS DISTINCT FROM task.session_id
    THEN RAISE EXCEPTION 'agent_task_target_mismatch'; END IF;
  IF NEW.target_kind='design' THEN
    object_id:=COALESCE(NEW.payload#>>'{target,placement,replace_object_id}',NEW.payload#>>'{target,source_object_id}');
    candidate:=jsonb_build_object('kind','design','designId',NEW.design_id);
    IF object_id IS NOT NULL THEN candidate:=candidate||jsonb_build_object('objectIds',jsonb_build_array(object_id)); END IF;
    IF NEW.design_id IS NULL OR NOT private.loomic_agent_task_target_authorized(task,candidate)
      OR NOT EXISTS (
        SELECT 1 FROM public.design_nodes node
        JOIN public.canvases target_canvas ON target_canvas.id=node.canvas_id
        JOIN public.canvases origin_canvas ON origin_canvas.id=task.canvas_id
        WHERE node.design_id=NEW.design_id AND node.deleted_at IS NULL
          AND target_canvas.workspace_id=origin_canvas.workspace_id AND target_canvas.project_id=origin_canvas.project_id
      ) THEN RAISE EXCEPTION 'agent_task_target_mismatch'; END IF;
  ELSIF NEW.target_kind='canvas' THEN
    candidate:=jsonb_build_object('kind','canvas_image','elementId',NEW.payload->>'source_element_id','assetId',NEW.payload->>'source_asset_id');
    IF NEW.canvas_id IS DISTINCT FROM task.canvas_id OR NOT private.loomic_agent_task_target_authorized(task,candidate)
      THEN RAISE EXCEPTION 'agent_task_target_mismatch'; END IF;
  ELSE
    RAISE EXCEPTION 'agent_task_target_mismatch';
  END IF;
  INSERT INTO public.agent_design_task_jobs(job_id,run_id) VALUES(NEW.id,origin);
  RETURN NEW;
END $$;

-- Native design command audit rows are the final SQL write boundary. A scoped
-- object list remains a subset constraint; scene-wide commands require a
-- whole-design scope.
CREATE OR REPLACE FUNCTION private.loomic_agent_task_guard_design_version()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE origin uuid; task public.agent_design_tasks; candidate jsonb; scene_wide boolean; BEGIN
  IF NEW.actor_kind='agent' THEN origin:=NEW.agent_run_id;
  ELSIF NEW.actor_kind='job' THEN
    SELECT binding.run_id INTO origin FROM public.job_target_finalizations finalization
      JOIN public.agent_design_task_jobs binding ON binding.job_id=finalization.job_id
      WHERE finalization.command_id=NEW.idempotency_key AND finalization.target_id=NEW.design_id;
  ELSE RETURN NEW; END IF;
  task:=private.loomic_agent_task_lock(origin);
  IF task.id IS NULL THEN RETURN NEW; END IF;
  scene_wide:=EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.command_batch) command
    WHERE command->>'action' IN ('scene.replace','canvas.update'));
  candidate:=jsonb_build_object('kind','design','designId',NEW.design_id);
  IF NOT scene_wide AND cardinality(NEW.changed_object_ids)>0 THEN
    candidate:=candidate||jsonb_build_object('objectIds',to_jsonb(NEW.changed_object_ids));
  END IF;
  IF NOT private.loomic_agent_task_target_authorized(task,candidate)
    OR NOT EXISTS (
      SELECT 1 FROM public.design_nodes node
      JOIN public.canvases target_canvas ON target_canvas.id=node.canvas_id
      JOIN public.canvases origin_canvas ON origin_canvas.id=task.canvas_id
      WHERE node.design_id=NEW.design_id AND node.deleted_at IS NULL
        AND target_canvas.workspace_id=origin_canvas.workspace_id AND target_canvas.project_id=origin_canvas.project_id
    ) THEN RAISE EXCEPTION 'agent_task_target_mismatch'; END IF;
  RETURN NEW;
END $$;

-- Durable destructive confirmations can target any member of the immutable
-- authenticated scope. Creation and claim both re-check the same frozen target
-- under the task lock; a model-produced design id alone never grants access.
CREATE OR REPLACE FUNCTION public.loomic_create_agent_action_confirmation(
  p_confirmation uuid,p_kind text,p_user uuid,p_workspace uuid,p_session uuid,p_canvas uuid,
  p_task uuid,p_task_revision bigint,p_origin_run uuid,p_tool_execution uuid,p_workflow_step text,
  p_details jsonb,p_payload jsonb,p_expires_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task public.agent_design_tasks; row_value public.agent_action_confirmations; candidate jsonb;
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_kind<>'design_mutation' OR p_expires_at<=now()
    OR p_details IS NULL OR jsonb_typeof(p_details)<>'object' OR octet_length(p_details::text)>10000
    OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>80000
    OR (p_workflow_step IS NOT NULL AND p_workflow_step !~ '^[a-z][a-z0-9_-]{0,63}$')
  THEN RAISE EXCEPTION 'agent_confirmation_invalid'; END IF;
  SELECT * INTO task FROM public.agent_design_tasks WHERE id=p_task FOR UPDATE;
  candidate:=private.loomic_agent_confirmation_target(p_payload);
  IF NOT FOUND OR task.created_by IS DISTINCT FROM p_user OR task.session_id IS DISTINCT FROM p_session
    OR task.canvas_id IS DISTINCT FROM p_canvas OR task.current_run_id IS DISTINCT FROM p_origin_run
    OR task.revision IS DISTINCT FROM p_task_revision OR candidate IS NULL
    OR NOT private.loomic_agent_task_target_authorized(task,candidate)
    OR NOT EXISTS(SELECT 1 FROM public.tool_executions e WHERE e.id=p_tool_execution
      AND e.run_id=p_origin_run AND e.requested_by=p_user AND e.tool_name='manipulate_design'
      AND e.status IN ('running','completed'))
    OR NOT EXISTS(SELECT 1 FROM public.design_nodes node
      JOIN public.canvases target_canvas ON target_canvas.id=node.canvas_id
      JOIN public.canvases origin_canvas ON origin_canvas.id=task.canvas_id
      WHERE node.design_id=(candidate->>'designId')::uuid AND node.deleted_at IS NULL
        AND target_canvas.workspace_id=p_workspace AND origin_canvas.workspace_id=p_workspace
        AND target_canvas.project_id=origin_canvas.project_id)
  THEN RAISE EXCEPTION 'agent_confirmation_scope_mismatch'; END IF;
  INSERT INTO public.agent_action_confirmations(
    confirmation_id,kind,user_id,workspace_id,session_id,canvas_id,task_id,task_revision,
    origin_run_id,tool_execution_id,workflow_step_id,details,payload,expires_at
  ) VALUES(
    p_confirmation,p_kind,p_user,p_workspace,p_session,p_canvas,p_task,p_task_revision,
    p_origin_run,p_tool_execution,p_workflow_step,p_details,p_payload,p_expires_at
  ) RETURNING * INTO row_value;
  RETURN private.loomic_agent_action_confirmation_snapshot(row_value);
END $$;

CREATE OR REPLACE FUNCTION public.loomic_claim_agent_action_confirmation(
  p_confirmation uuid,p_user uuid,p_canvas uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE row_value public.agent_action_confirmations; task public.agent_design_tasks; token uuid; candidate jsonb;
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT * INTO row_value FROM public.agent_action_confirmations WHERE confirmation_id=p_confirmation FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','not_found'); END IF;
  IF row_value.user_id IS DISTINCT FROM p_user OR row_value.canvas_id IS DISTINCT FROM p_canvas
  THEN RAISE EXCEPTION 'confirmation_forbidden'; END IF;
  IF row_value.status='applied' THEN
    RETURN jsonb_build_object('state','applied','action',private.loomic_agent_action_confirmation_snapshot(row_value));
  END IF;
  IF row_value.status='canceled' THEN RETURN jsonb_build_object('state','canceled'); END IF;
  SELECT * INTO task FROM public.agent_design_tasks WHERE id=row_value.task_id FOR UPDATE;
  candidate:=private.loomic_agent_confirmation_target(row_value.payload);
  IF row_value.status='pending' AND row_value.confirmed_at IS NULL AND row_value.expires_at<=now() THEN
    UPDATE public.agent_action_confirmations SET status='canceled',updated_at=now() WHERE confirmation_id=p_confirmation;
    RETURN jsonb_build_object('state','expired');
  END IF;
  IF NOT FOUND OR task.created_by IS DISTINCT FROM row_value.user_id
    OR task.session_id IS DISTINCT FROM row_value.session_id OR task.canvas_id IS DISTINCT FROM row_value.canvas_id
    OR task.current_run_id IS DISTINCT FROM row_value.origin_run_id OR task.revision IS DISTINCT FROM row_value.task_revision
    OR candidate IS NULL OR NOT private.loomic_agent_task_target_authorized(task,candidate)
    OR NOT EXISTS(SELECT 1 FROM public.design_nodes node
      JOIN public.canvases target_canvas ON target_canvas.id=node.canvas_id
      JOIN public.canvases origin_canvas ON origin_canvas.id=task.canvas_id
      WHERE node.design_id=(candidate->>'designId')::uuid AND node.deleted_at IS NULL
        AND target_canvas.workspace_id=row_value.workspace_id AND origin_canvas.workspace_id=row_value.workspace_id
        AND target_canvas.project_id=origin_canvas.project_id)
  THEN
    UPDATE public.agent_action_confirmations SET status='canceled',updated_at=now() WHERE confirmation_id=p_confirmation;
    RETURN jsonb_build_object('state','stale');
  END IF;
  IF row_value.status='executing' AND row_value.claimed_at>=now()-interval '3 minutes'
  THEN RETURN jsonb_build_object('state','executing'); END IF;
  token:=extensions.gen_random_uuid();
  UPDATE public.agent_action_confirmations SET status='executing',claim_token=token,claimed_at=now(),confirmed_at=COALESCE(confirmed_at,now()),updated_at=now()
    WHERE confirmation_id=p_confirmation RETURNING * INTO row_value;
  RETURN jsonb_build_object('state','claimed','action',private.loomic_agent_action_confirmation_snapshot(row_value));
END $$;

-- A terminal job on a secondary, explicitly authorized board must produce the
-- same durable continuation as the canonical target. The immutable job binding
-- remains the provenance link; current revision and scope are checked again.
CREATE OR REPLACE FUNCTION private.loomic_record_agent_continuation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  task public.agent_design_tasks;
  mapped public.agent_design_task_runs;
  candidate jsonb;
  object_id text;
BEGIN
  IF NEW.job_type <> 'image_generation' OR NEW.status NOT IN ('succeeded','failed','canceled','dead_letter') THEN RETURN NEW; END IF;
  IF NEW.status='succeeded' AND NOT (NEW.result ? 'canvas_finalized_at' OR NEW.result ? 'chat_finalized_at') THEN RETURN NEW; END IF;
  SELECT r.* INTO mapped FROM public.agent_design_task_jobs b
    JOIN public.agent_design_task_runs r ON r.run_id=b.run_id WHERE b.job_id=NEW.id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO task FROM public.agent_design_tasks WHERE id=mapped.task_id;
  IF NEW.target_kind='design' THEN
    object_id:=COALESCE(NEW.payload#>>'{target,placement,replace_object_id}',NEW.payload#>>'{target,source_object_id}');
    candidate:=jsonb_build_object('kind','design','designId',NEW.design_id);
    IF object_id IS NOT NULL THEN candidate:=candidate||jsonb_build_object('objectIds',jsonb_build_array(object_id)); END IF;
  ELSIF NEW.target_kind='canvas' THEN
    candidate:=jsonb_build_object('kind','canvas_image','elementId',NEW.payload->>'source_element_id','assetId',NEW.payload->>'source_asset_id');
  ELSE
    RETURN NEW;
  END IF;
  IF task.current_run_id IS DISTINCT FROM mapped.run_id OR task.revision IS DISTINCT FROM mapped.revision
    OR task.created_by IS DISTINCT FROM NEW.created_by OR task.session_id IS DISTINCT FROM NEW.session_id
    OR (NEW.target_kind='canvas' AND task.canvas_id IS DISTINCT FROM NEW.canvas_id)
    OR NOT private.loomic_agent_task_target_authorized(task,candidate)
    THEN RETURN NEW; END IF;
  INSERT INTO public.agent_task_continuations(job_id,task_id,task_revision,origin_run_id,created_by,workspace_id,session_id,canvas_id)
    VALUES(NEW.id,task.id,task.revision,mapped.run_id,task.created_by,NEW.workspace_id,task.session_id,task.canvas_id)
    ON CONFLICT(job_id) DO NOTHING;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION private.loomic_agent_target_subset(jsonb,jsonb),
  private.loomic_agent_task_target_authorized(public.agent_design_tasks,jsonb),
  private.loomic_agent_confirmation_target(jsonb),
  private.loomic_record_agent_continuation()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.loomic_agent_target_scope_activate(uuid,uuid,uuid,bigint,jsonb),
  public.loomic_agent_target_scope_list(uuid,uuid,uuid,bigint),
  public.loomic_agent_target_scope_assert(uuid,uuid,uuid,bigint,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_agent_target_scope_activate(uuid,uuid,uuid,bigint,jsonb),
  public.loomic_agent_target_scope_list(uuid,uuid,uuid,bigint),
  public.loomic_agent_target_scope_assert(uuid,uuid,uuid,bigint,jsonb)
  TO service_role;
NOTIFY pgrst,'reload schema';
