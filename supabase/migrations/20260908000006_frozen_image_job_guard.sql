-- Enforce the frozen proposal at the job storage boundary, including direct
-- authenticated table writes. Recovery must not trust caller-edited payloads.
CREATE FUNCTION public.loomic_guard_frozen_image_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.image_generation_proposals; BEGIN
  IF TG_OP='UPDATE' THEN
    SELECT * INTO p FROM public.image_generation_proposals WHERE id=OLD.id OR id=NEW.id LIMIT 1;
  ELSE
    SELECT * INTO p FROM public.image_generation_proposals WHERE id=NEW.id;
  END IF;
  IF p.id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.payload IS DISTINCT FROM OLD.payload
      OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.session_id IS DISTINCT FROM OLD.session_id
      OR NEW.canvas_id IS DISTINCT FROM OLD.canvas_id OR NEW.design_id IS DISTINCT FROM OLD.design_id
      OR NEW.target_kind IS DISTINCT FROM OLD.target_kind OR NEW.job_type IS DISTINCT FROM OLD.job_type
    THEN RAISE EXCEPTION 'frozen_image_job_immutable'; END IF;
    RETURN NEW;
  END IF;
  IF p.status<>'confirmed' OR p.approved_cost IS NULL OR NEW.created_by IS DISTINCT FROM p.created_by
    OR NEW.session_id IS DISTINCT FROM p.session_id OR NEW.job_type::text<>'image_generation'
    OR NEW.payload->>'model' IS DISTINCT FROM p.input->>'model'
    OR NEW.payload->>'prompt' IS DISTINCT FROM p.input->>'prompt'
    OR NEW.payload->>'aspect_ratio' IS DISTINCT FROM COALESCE(p.input->>'aspectRatio','1:1')
    OR COALESCE(NEW.payload->'input_images','[]'::jsonb) IS DISTINCT FROM COALESCE(p.input->'inputImages','[]'::jsonb)
    OR (p.input ? 'quality' AND NEW.payload->>'quality' IS DISTINCT FROM p.input->>'quality')
    OR NEW.payload ? 'operation'
    OR NOT EXISTS (SELECT 1 FROM public.canvases c WHERE c.id=p.canvas_id AND c.workspace_id=NEW.workspace_id)
  THEN RAISE EXCEPTION 'frozen_image_job_mismatch'; END IF;
  IF p.input->'target'->>'kind'='design' THEN
    IF NEW.target_kind IS DISTINCT FROM 'design' OR NEW.design_id::text IS DISTINCT FROM p.input->'target'->>'design_id'
      OR NEW.payload->'target' IS DISTINCT FROM p.input->'target'
    THEN RAISE EXCEPTION 'frozen_image_target_mismatch'; END IF;
  ELSE
    IF NEW.target_kind IS DISTINCT FROM 'canvas' OR NEW.canvas_id IS DISTINCT FROM p.canvas_id
      OR NEW.payload->'target'->>'canvas_id' IS DISTINCT FROM p.canvas_id::text
    THEN RAISE EXCEPTION 'frozen_image_target_mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.loomic_guard_frozen_image_job() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER frozen_image_job_guard BEFORE INSERT OR UPDATE ON public.background_jobs
FOR EACH ROW EXECUTE FUNCTION public.loomic_guard_frozen_image_job();
