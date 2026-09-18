-- Run inside BEGIN/ROLLBACK after installing migration 20260911000013 in
-- that same transaction. All inserted rows are synthetic and rolled back.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT public.loomic_realtime_consumer_register('aaaaaaaa-1111-4111-8111-111111111111');
SELECT public.loomic_realtime_consumer_register('bbbbbbbb-1111-4111-8111-111111111111');
INSERT INTO public.realtime_event_log(event_type, aggregate_id, workspace_id, payload)
VALUES ('design.sync', 'cccccccc-1111-4111-8111-111111111111',
  'dddddddd-1111-4111-8111-111111111111',
  '{"type":"design.sync","designId":"cccccccc-1111-4111-8111-111111111111","revision":1,"updateType":"mutated","changedObjectIds":[]}');
DO $$
DECLARE event_number bigint; row_count integer;
BEGIN
  SELECT max(id) INTO event_number FROM public.realtime_event_log;
  SELECT count(*) INTO row_count FROM public.loomic_realtime_consumer_poll('aaaaaaaa-1111-4111-8111-111111111111', 25);
  IF row_count <> 1 THEN RAISE EXCEPTION 'consumer A did not receive event'; END IF;
  IF NOT public.loomic_realtime_consumer_ack('aaaaaaaa-1111-4111-8111-111111111111', event_number) THEN RAISE EXCEPTION 'ack failed'; END IF;
  SELECT count(*) INTO row_count FROM public.loomic_realtime_consumer_poll('bbbbbbbb-1111-4111-8111-111111111111', 25);
  IF row_count <> 1 THEN RAISE EXCEPTION 'A acknowledgement consumed B event'; END IF;
  SELECT count(*) INTO row_count FROM public.loomic_realtime_consumer_poll('aaaaaaaa-1111-4111-8111-111111111111', 25);
  IF row_count <> 0 THEN RAISE EXCEPTION 'acknowledged event replayed'; END IF;
  IF NOT public.loomic_realtime_canvas_authorized('e9bc3fe5-7ba7-48dd-aff7-26393ecedcbb', 'f65f97ff-a148-44ad-941a-4d9c3a2ea225') THEN RAISE EXCEPTION 'QA owner authorization failed'; END IF;
  IF public.loomic_realtime_canvas_authorized('32ed2ea4-56b1-481c-9b1b-047a82cf8f1c', 'f65f97ff-a148-44ad-941a-4d9c3a2ea225') THEN RAISE EXCEPTION 'foreign QA user authorization passed'; END IF;
END;
$$;
SELECT public.loomic_realtime_consumer_unregister('aaaaaaaa-1111-4111-8111-111111111111');
-- Exercise both membership triggers using a temporary QA-only membership.
INSERT INTO public.workspace_members(workspace_id, user_id, role)
VALUES ('d9e857af-593c-441b-9249-823293e29e91', '32ed2ea4-56b1-481c-9b1b-047a82cf8f1c', 'member');
UPDATE public.workspace_members SET role = 'admin'
WHERE workspace_id = 'd9e857af-593c-441b-9249-823293e29e91' AND user_id = '32ed2ea4-56b1-481c-9b1b-047a82cf8f1c';
DELETE FROM public.workspace_members
WHERE workspace_id = 'd9e857af-593c-441b-9249-823293e29e91' AND user_id = '32ed2ea4-56b1-481c-9b1b-047a82cf8f1c';
DO $$
BEGIN
  IF (SELECT count(*) FROM public.realtime_event_log WHERE event_type = 'workspace.membership.changed'
      AND payload->>'userId' = '32ed2ea4-56b1-481c-9b1b-047a82cf8f1c') <> 2 THEN
    RAISE EXCEPTION 'role update/delete triggers did not emit both events';
  END IF;
END;
$$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.loomic_realtime_consumer_register('aaaaaaaa-1111-4111-8111-111111111111');
    RAISE EXCEPTION 'authenticated user unexpectedly registered consumer';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF has_table_privilege('authenticated', 'public.realtime_event_log', 'SELECT') THEN RAISE EXCEPTION 'event log readable by ordinary user'; END IF;
END;
$$;
RESET ROLE;
