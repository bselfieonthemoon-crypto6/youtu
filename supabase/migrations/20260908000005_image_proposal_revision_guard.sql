CREATE FUNCTION public.loomic_invalidate_image_proposals(p_session uuid,p_canvas uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM 1 FROM public.chat_sessions s JOIN public.canvases c ON c.id=s.canvas_id
    WHERE s.id=p_session AND s.canvas_id=p_canvas AND s.created_by=auth.uid()
      AND EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=c.workspace_id AND m.user_id=auth.uid())
    FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'image_session_forbidden'; END IF;
  UPDATE public.image_generation_proposals SET status='superseded'
    WHERE session_id=p_session AND created_by=auth.uid() AND status='pending';
END $$;
REVOKE ALL ON FUNCTION public.loomic_invalidate_image_proposals(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.loomic_invalidate_image_proposals(uuid,uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
