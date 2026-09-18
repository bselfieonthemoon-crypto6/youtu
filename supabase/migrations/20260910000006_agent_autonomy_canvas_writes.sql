-- Only whole-board translation is authorized here. No caller-provided scene,
-- content replacement, deletion, resize, grouping or native design commands.
CREATE TABLE public.agent_autonomy_canvas_arrangements (
 task_id uuid NOT NULL REFERENCES public.agent_design_tasks(id) ON DELETE CASCADE,
 task_revision bigint NOT NULL, idempotency_key uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES auth.users(id), input jsonb NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,task_revision,idempotency_key)
);
ALTER TABLE public.agent_autonomy_canvas_arrangements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_autonomy_canvas_arrangements FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_autonomy_canvas_arrangements FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.loomic_autonomy_arrange_design_boards(
 p_user uuid,p_session uuid,p_token uuid,p_input jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 grant_row public.agent_task_autonomy; task_row public.agent_design_tasks;
 canvas_row public.canvases; node_row public.design_nodes; design_row public.design_documents;
 previous public.agent_autonomy_canvas_arrangements; position jsonb; element jsonb;
 next_elements jsonb; result_positions jsonb:='[]'; result_value jsonb; operation_id uuid;
 node_index integer; node_count integer; version_value integer; candidate jsonb;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
 -- Same lock order and locks as stop/correction; locks survive until COMMIT.
 PERFORM private.loomic_assert_autonomy_commit(p_user,p_session,p_token);
 SELECT * INTO STRICT grant_row FROM public.agent_task_autonomy WHERE session_id=p_session;
 SELECT * INTO STRICT task_row FROM public.agent_design_tasks WHERE id=grant_row.task_id;
 IF p_input IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
   OR NOT (p_input ?& ARRAY['idempotency_key','positions'])
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) key WHERE key NOT IN ('idempotency_key','positions'))
   OR COALESCE(p_input->>'idempotency_key','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR jsonb_typeof(p_input->'positions') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'positions') NOT BETWEEN 1 AND 20
   OR octet_length(p_input::text)>30000 THEN RAISE EXCEPTION 'autonomy_canvas_invalid'; END IF;
 operation_id:=(p_input->>'idempotency_key')::uuid;
 IF (SELECT count(DISTINCT value->>'element_id') FROM jsonb_array_elements(p_input->'positions'))<>jsonb_array_length(p_input->'positions')
   OR (SELECT count(DISTINCT value->>'design_id') FROM jsonb_array_elements(p_input->'positions'))<>jsonb_array_length(p_input->'positions')
 THEN RAISE EXCEPTION 'autonomy_canvas_duplicate_target'; END IF;
 PERFORM 1 FROM public.workspace_members WHERE workspace_id=grant_row.workspace_id AND user_id=p_user
   AND role IN ('owner','admin') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'autonomy_canvas_forbidden'; END IF;
 SELECT * INTO previous FROM public.agent_autonomy_canvas_arrangements
   WHERE task_id=task_row.id AND task_revision=task_row.revision AND idempotency_key=operation_id;
 IF FOUND THEN
   IF previous.created_by IS DISTINCT FROM p_user OR previous.input IS DISTINCT FROM p_input
   THEN RAISE EXCEPTION 'autonomy_canvas_idempotency_conflict'; END IF;
   RETURN previous.result||jsonb_build_object('replayed',true);
 END IF;
 -- Lock authoritative node bindings before canvas, matching design lifecycle.
 PERFORM 1 FROM public.design_nodes WHERE canvas_id=grant_row.canvas_id
   AND element_id IN (SELECT value->>'element_id' FROM jsonb_array_elements(p_input->'positions'))
   ORDER BY element_id FOR UPDATE;
 SELECT * INTO canvas_row FROM public.canvases WHERE id=grant_row.canvas_id FOR UPDATE;
 IF canvas_row.id IS NULL OR canvas_row.workspace_id IS DISTINCT FROM grant_row.workspace_id
   OR jsonb_typeof(canvas_row.content->'elements') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'autonomy_canvas_forbidden'; END IF;
 next_elements:=canvas_row.content->'elements';
 FOR position IN SELECT value FROM jsonb_array_elements(p_input->'positions') LOOP
   IF jsonb_typeof(position) IS DISTINCT FROM 'object'
     OR NOT (position ?& ARRAY['design_id','element_id','expected_version','expected_x','expected_y','x','y'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(position) key WHERE key NOT IN ('design_id','element_id','expected_version','expected_x','expected_y','x','y'))
     OR COALESCE(position->>'design_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR jsonb_typeof(position->'element_id') IS DISTINCT FROM 'string' OR char_length(position->>'element_id') NOT BETWEEN 1 AND 200
     OR EXISTS(SELECT 1 FROM unnest(ARRAY['expected_version','expected_x','expected_y','x','y']) key WHERE jsonb_typeof(position->key) IS DISTINCT FROM 'number')
   THEN RAISE EXCEPTION 'autonomy_canvas_invalid'; END IF;
   IF (position->>'expected_version')::numeric NOT BETWEEN 1 AND 2147483646
     OR trunc((position->>'expected_version')::numeric)<>(position->>'expected_version')::numeric
     OR EXISTS(SELECT 1 FROM unnest(ARRAY['expected_x','expected_y','x','y']) key WHERE abs((position->>key)::numeric)>1000000)
   THEN RAISE EXCEPTION 'autonomy_canvas_invalid'; END IF;
   candidate:=jsonb_build_object('kind','design','designId',position->>'design_id');
   -- Whole-design scope only, including an exact element binding if supplied.
   IF NOT EXISTS(SELECT 1 FROM (
     SELECT task_row.target AS target UNION ALL SELECT scope.target FROM public.agent_task_target_scopes scope
     WHERE scope.task_id=task_row.id AND scope.task_revision=task_row.revision
       AND scope.created_by=p_user AND scope.session_id=p_session
   ) allowed WHERE private.loomic_agent_target_subset(candidate,allowed.target)
     AND (NOT (allowed.target ? 'elementId') OR allowed.target->>'elementId'=position->>'element_id'))
   THEN RAISE EXCEPTION 'autonomy_canvas_target_mismatch'; END IF;
   SELECT * INTO node_row FROM public.design_nodes WHERE canvas_id=canvas_row.id
     AND element_id=position->>'element_id' AND design_id=(position->>'design_id')::uuid
     AND workspace_id=grant_row.workspace_id AND deleted_at IS NULL;
   SELECT * INTO design_row FROM public.design_documents WHERE id=(position->>'design_id')::uuid;
   IF node_row.design_id IS NULL OR design_row.id IS NULL OR design_row.deleted_at IS NOT NULL
     OR design_row.workspace_id IS DISTINCT FROM canvas_row.workspace_id
     OR design_row.project_id IS DISTINCT FROM canvas_row.project_id
   THEN RAISE EXCEPTION 'autonomy_canvas_target_mismatch'; END IF;
   SELECT count(*) INTO node_count FROM jsonb_array_elements(next_elements) value WHERE value->>'id'=position->>'element_id';
   IF node_count<>1 THEN RAISE EXCEPTION 'autonomy_canvas_ambiguous_node'; END IF;
   SELECT value,ordinality::integer-1 INTO element,node_index FROM jsonb_array_elements(next_elements) WITH ORDINALITY
     WHERE value->>'id'=position->>'element_id';
   IF element#>>'{customData,kind}' IS DISTINCT FROM 'loomic-design'
     OR element#>>'{customData,designId}' IS DISTINCT FROM position->>'design_id'
     OR COALESCE(element->>'isDeleted','false')<>'false' OR COALESCE(element->>'locked','false')<>'false'
     OR COALESCE(element->'groupIds','[]')<>'[]'::jsonb OR COALESCE(element->>'frameId','')<>''
     OR COALESCE(element->'boundElements','null') NOT IN ('null'::jsonb,'[]'::jsonb)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(next_elements) other WHERE COALESCE(other->>'isDeleted','false')='false'
       AND (other#>>'{startBinding,elementId}'=position->>'element_id' OR other#>>'{endBinding,elementId}'=position->>'element_id'
         OR other->>'containerId'=position->>'element_id'))
   THEN RAISE EXCEPTION 'autonomy_canvas_unsupported_node'; END IF;
   IF element->'version' IS DISTINCT FROM position->'expected_version'
     OR element->'x' IS DISTINCT FROM position->'expected_x' OR element->'y' IS DISTINCT FROM position->'expected_y'
   THEN RAISE EXCEPTION 'autonomy_canvas_revision_conflict'; END IF;
   version_value:=(position->>'expected_version')::integer+1;
   element:=element||jsonb_build_object('x',position->'x','y',position->'y','version',version_value,
     'versionNonce',floor(random()*2147483647)::integer,'updated',floor(extract(epoch from clock_timestamp())*1000)::bigint);
   next_elements:=jsonb_set(next_elements,ARRAY[node_index::text],element);
   result_positions:=result_positions||jsonb_build_array(jsonb_build_object('design_id',position->>'design_id',
     'element_id',position->>'element_id','x',position->'x','y',position->'y','version',version_value));
 END LOOP;
 -- Final commit fence. No external write precedes this transactional UPDATE.
 PERFORM private.loomic_assert_autonomy_commit(p_user,p_session,p_token);
 UPDATE public.canvases SET content=jsonb_set(canvas_row.content,'{elements}',next_elements),revision=canvas_row.revision+1
   WHERE id=canvas_row.id;
 result_value:=jsonb_build_object('status','applied','canvas_id',canvas_row.id,'revision',canvas_row.revision+1,
   'positions',result_positions,'replayed',false);
 INSERT INTO public.agent_autonomy_canvas_arrangements(task_id,task_revision,idempotency_key,created_by,input,result)
 VALUES(task_row.id,task_row.revision,operation_id,p_user,p_input,result_value);
 RETURN result_value;
END $$;
REVOKE ALL ON FUNCTION public.loomic_autonomy_arrange_design_boards(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_autonomy_arrange_design_boards(uuid,uuid,uuid,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
