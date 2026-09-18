\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'loomic_replica_light_20260907'
    OR to_regprocedure('public.save_skill_package(uuid,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Expected migrated local replica';
  END IF;
END $$;
CREATE TEMP TABLE qa_checks(label text NOT NULL);
GRANT SELECT, INSERT ON qa_checks TO authenticated, anon;
CREATE FUNCTION pg_temp.assert_ok(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Skills QA failed: %', label; END IF;
  INSERT INTO pg_temp.qa_checks VALUES (label);
END $$;
INSERT INTO auth.users(id,email) VALUES
  ('__OWNER__','skills-owner-__NONCE__@example.invalid'),
  ('__MEMBER__','skills-member-__NONCE__@example.invalid'),
  ('__OUTSIDER__','skills-outsider-__NONCE__@example.invalid');
INSERT INTO public.workspaces(id,type,name,owner_user_id) VALUES
  ('__WORKSPACE__','team','QA skill shared workspace','__OWNER__'),
  ('__OUTSIDE_WORKSPACE__','team','QA unrelated workspace','__OUTSIDER__');
INSERT INTO public.workspace_members(workspace_id,user_id,role) VALUES
  ('__WORKSPACE__','__OWNER__','owner'), ('__WORKSPACE__','__MEMBER__','member'),
  ('__OUTSIDE_WORKSPACE__','__OUTSIDER__','owner');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"__OWNER__","role":"authenticated"}',true) IS NOT NULL;
DO $$ DECLARE result jsonb; BEGIN
  result := public.save_skill_package(NULL,'__WORKSPACE__',jsonb_build_object(
    'name','QA skill','slug','qa-skills-__NONCE__','description','A bounded QA skill','category','design',
    'skillContent','Read the task and preserve its scope.',
    'files',jsonb_build_array(jsonb_build_object('filePath','references/中文 说明.md','content','Original reference'),
      jsonb_build_object('filePath','references/other.md','content','Other reference'))));
  PERFORM set_config('qa.skill_id',result->'skill'->>'id',true);
  PERFORM pg_temp.assert_ok(jsonb_array_length(result->'files')=2,'atomic create returns complete package');
END $$;
SELECT pg_temp.assert_ok((SELECT count(*)=1 FROM public.workspace_skills WHERE workspace_id='__WORKSPACE__'
  AND skill_id=current_setting('qa.skill_id')::uuid AND enabled),'create atomically installs into requested workspace');
SELECT pg_temp.assert_ok((SELECT count(*)=2 FROM public.skill_files WHERE skill_id=current_setting('qa.skill_id')::uuid),'references persisted');
DO $$ DECLARE result jsonb; BEGIN
  result := public.save_skill_package(current_setting('qa.skill_id')::uuid,NULL,'{"name":"Renamed QA skill"}');
  PERFORM pg_temp.assert_ok(result->'skill'->>'slug'='qa-skills-__NONCE__' AND jsonb_array_length(result->'files')=2,
    'rename preserves slug and omitted references');
  result := public.save_skill_package(current_setting('qa.skill_id')::uuid,NULL,'{"files":[]}');
  PERFORM pg_temp.assert_ok(jsonb_array_length(result->'files')=0,'explicit empty files clears references');
  PERFORM public.save_skill_package(current_setting('qa.skill_id')::uuid,NULL,
    '{"files":[{"filePath":"references/keep.md","content":"Keep this reference"}]}');
END $$;
DO $$ BEGIN
  BEGIN
    PERFORM public.save_skill_package(NULL,'__WORKSPACE__',jsonb_build_object('name','Must rollback','slug','qa-skills-__NONCE__-invalid',
      'description','Invalid package','category','design','skillContent','Instructions',
      'files',jsonb_build_array(jsonb_build_object('filePath','references/../outside.md','content','bad'))));
    RAISE EXCEPTION 'invalid create unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  PERFORM pg_temp.assert_ok(NOT EXISTS(SELECT 1 FROM public.skills WHERE slug='qa-skills-__NONCE__-invalid'),
    'failed create leaves no package or install');
  BEGIN
    PERFORM public.save_skill_package(current_setting('qa.skill_id')::uuid,NULL,
      '{"name":"Do not persist","files":[{"filePath":"references/A.md","content":"x"},{"filePath":"references/a.md","content":"y"}]}');
    RAISE EXCEPTION 'duplicate paths unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  PERFORM pg_temp.assert_ok((SELECT name='Renamed QA skill' FROM public.skills WHERE id=current_setting('qa.skill_id')::uuid)
    AND (SELECT count(*)=1 AND bool_and(content='Keep this reference') FROM public.skill_files WHERE skill_id=current_setting('qa.skill_id')::uuid),
    'failed replacement rolls back metadata and files');
  BEGIN
    UPDATE public.skills SET slug='qa-skills-__NONCE__-changed' WHERE id=current_setting('qa.skill_id')::uuid;
    RAISE EXCEPTION 'slug mutation unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  PERFORM pg_temp.assert_ok((SELECT slug='qa-skills-__NONCE__' FROM public.skills WHERE id=current_setting('qa.skill_id')::uuid),'direct SQL cannot rename slug');
  BEGIN
    UPDATE public.skills SET source='system' WHERE id=current_setting('qa.skill_id')::uuid;
    RAISE EXCEPTION 'source promotion unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM pg_temp.assert_ok((SELECT source='user' FROM public.skills WHERE id=current_setting('qa.skill_id')::uuid),'author cannot promote private instructions to system');
  BEGIN
    INSERT INTO public.skill_files(skill_id,file_path,content) VALUES(current_setting('qa.skill_id')::uuid,'references/invalid.md',repeat('x',2097153));
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'direct oversized file unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  PERFORM pg_temp.assert_ok(NOT EXISTS(SELECT 1 FROM public.skill_files WHERE skill_id=current_setting('qa.skill_id')::uuid AND file_path='references/invalid.md'),
    'direct writes obey deferred package constraints');
  BEGIN
    PERFORM public.save_skill_package(NULL,'__WORKSPACE__',jsonb_build_object('name','Bad metadata','slug','qa-skills-__NONCE__-metadata',
      'description','Invalid metadata','category','design','skillContent','Instructions','metadata','[]'::jsonb));
    RAISE EXCEPTION 'array metadata unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  PERFORM pg_temp.assert_ok(NOT EXISTS(SELECT 1 FROM public.skills WHERE slug='qa-skills-__NONCE__-metadata'),'metadata shape enforced below HTTP');
  BEGIN
    PERFORM public.save_skill_package(current_setting('qa.skill_id')::uuid,NULL,jsonb_build_object('files',
      (SELECT jsonb_agg(jsonb_build_object('filePath','references/'||i||'.md','content',repeat('a',2097152))) FROM generate_series(1,4) i)));
    RAISE EXCEPTION 'aggregate budget unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  PERFORM pg_temp.assert_ok((SELECT count(*)=1 FROM public.skill_files WHERE skill_id=current_setting('qa.skill_id')::uuid),'aggregate 8 MiB budget rolls back replacement');
END $$;
SELECT set_config('request.jwt.claims','{"sub":"__MEMBER__","role":"authenticated"}',true) IS NOT NULL;
SELECT pg_temp.assert_ok((SELECT count(*)=1 FROM public.skills WHERE id=current_setting('qa.skill_id')::uuid),'member can read installed private skill');
SELECT pg_temp.assert_ok((SELECT count(*)=1 FROM public.skill_files WHERE skill_id=current_setting('qa.skill_id')::uuid),'member can read private references');
DO $$ BEGIN
  BEGIN
    PERFORM public.save_skill_package(current_setting('qa.skill_id')::uuid,NULL,'{"name":"Member overwrite"}');
    RAISE EXCEPTION 'member update unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  PERFORM pg_temp.assert_ok((SELECT name='Renamed QA skill' FROM public.skills WHERE id=current_setting('qa.skill_id')::uuid),'membership does not grant author mutation');
  BEGIN
    PERFORM public.install_skill_package('__WORKSPACE__',current_setting('qa.skill_id')::uuid,false);
    RAISE EXCEPTION 'member toggle unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM pg_temp.assert_ok((SELECT enabled FROM public.workspace_skills WHERE workspace_id='__WORKSPACE__' AND skill_id=current_setting('qa.skill_id')::uuid),
    'non-admin cannot toggle installation');
  BEGIN
    INSERT INTO public.skill_files(skill_id,file_path,content) VALUES(current_setting('qa.skill_id')::uuid,'references/member.md','overwrite');
    RAISE EXCEPTION 'member file insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM pg_temp.assert_ok(NOT EXISTS(SELECT 1 FROM public.skill_files WHERE skill_id=current_setting('qa.skill_id')::uuid AND file_path='references/member.md'),
    'non-author cannot write references');
END $$;
SELECT set_config('request.jwt.claims','{"sub":"__OUTSIDER__","role":"authenticated"}',true) IS NOT NULL;
SELECT pg_temp.assert_ok(NOT EXISTS(SELECT 1 FROM public.skills WHERE id=current_setting('qa.skill_id')::uuid),'outsider cannot read private skill');
SELECT pg_temp.assert_ok(NOT EXISTS(SELECT 1 FROM public.skill_files WHERE skill_id=current_setting('qa.skill_id')::uuid),'outsider cannot read private references');
DO $$ BEGIN
  BEGIN
    PERFORM public.install_skill_package('__OUTSIDE_WORKSPACE__',current_setting('qa.skill_id')::uuid,true);
    RAISE EXCEPTION 'guessed private ID install unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  BEGIN
    INSERT INTO public.workspace_skills(workspace_id,skill_id,installed_by)
      VALUES('__OUTSIDE_WORKSPACE__',current_setting('qa.skill_id')::uuid,'__OUTSIDER__');
    RAISE EXCEPTION 'direct guessed private ID install unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  PERFORM pg_temp.assert_ok(NOT EXISTS(SELECT 1 FROM public.workspace_skills WHERE workspace_id='__OUTSIDE_WORKSPACE__' AND skill_id=current_setting('qa.skill_id')::uuid),
    'RPC and direct insert reject guessed private skill ID');
END $$;
SELECT set_config('request.jwt.claims','{"sub":"__OWNER__","role":"authenticated"}',true) IS NOT NULL;
DO $$ BEGIN
  UPDATE public.skills SET skill_content='' WHERE id=current_setting('qa.skill_id')::uuid;
  PERFORM public.install_skill_package('__WORKSPACE__',current_setting('qa.skill_id')::uuid,false);
  PERFORM pg_temp.assert_ok((SELECT NOT enabled FROM public.workspace_skills WHERE workspace_id='__WORKSPACE__' AND skill_id=current_setting('qa.skill_id')::uuid),
    'broken installed package can still be disabled');
  BEGIN
    PERFORM public.install_skill_package('__WORKSPACE__',current_setting('qa.skill_id')::uuid,true);
    RAISE EXCEPTION 'broken package enabling unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  PERFORM pg_temp.assert_ok((SELECT NOT enabled FROM public.workspace_skills WHERE workspace_id='__WORKSPACE__' AND skill_id=current_setting('qa.skill_id')::uuid),
    'broken package cannot be enabled');
  UPDATE public.skills SET skill_content='Restored valid instructions' WHERE id=current_setting('qa.skill_id')::uuid;
  PERFORM public.install_skill_package('__WORKSPACE__',current_setting('qa.skill_id')::uuid,true);
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
SET LOCAL ROLE anon;
DO $$ BEGIN
  BEGIN
    PERFORM public.save_skill_package(NULL,'__WORKSPACE__','{}');
    RAISE EXCEPTION 'anon RPC unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM pg_temp.assert_ok(true,'anonymous callers cannot execute package RPC');
END $$;
RESET ROLE;
SELECT jsonb_build_object('status','passed','checks',count(*),'labels',jsonb_agg(label),
  'database',current_database(),'cleanup','entire transaction rolled back') FROM qa_checks;
ROLLBACK;
