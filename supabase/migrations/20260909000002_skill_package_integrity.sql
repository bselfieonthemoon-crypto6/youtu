-- Package writes use the caller's JWT/RLS, never a service-role bypass.
-- No existing skill content, installation, or canvas data is rewritten here.

CREATE OR REPLACE FUNCTION private.safe_skill_file_path(p_path text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_path IS NOT NULL AND length(p_path) <= 500
    AND p_path ~ '^(scripts|references|assets)/'
    AND p_path !~ '[\\:%?#[:cntrl:]]'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(string_to_array(p_path, '/')) part
      WHERE part IN ('', '.', '..') OR part ~ '[. ]$'
        OR part ~* '^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.]|$)'
    );
$$;

CREATE OR REPLACE FUNCTION private.assert_skill_package(p_skill_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE s public.skills%ROWTYPE; file_count bigint; file_bytes bigint; unique_count bigint;
BEGIN
  -- Every package/file/install writer takes this same lock before inspecting
  -- aggregate budgets, preventing concurrent small writes exceeding the limit.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_skill_id::text, 913));
  SELECT * INTO s FROM public.skills WHERE id = p_skill_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'skill_not_found' USING ERRCODE = '22023'; END IF;
  IF length(btrim(s.skill_content)) = 0 OR octet_length(s.skill_content) > 262144
    OR s.slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(s.slug) > 100
    OR length(btrim(s.name)) = 0 OR length(s.name) > 200
    OR length(btrim(s.description)) = 0 OR length(s.description) > 2000
    OR length(btrim(s.author)) = 0 OR length(s.author) > 200
    OR length(btrim(s.version)) = 0 OR length(s.version) > 100
    OR length(s.license) > 1000 OR length(s.icon_name) > 100
    OR length(s.source_url) > 2000 OR length(s.package_name) > 214
    OR jsonb_typeof(coalesce(s.metadata, '{}'::jsonb)) IS DISTINCT FROM 'object'
    OR octet_length(coalesce(s.metadata, '{}'::jsonb)::text) > 65536 THEN
    RAISE EXCEPTION 'skill_invalid_package' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.skill_files f WHERE f.skill_id = p_skill_id AND (
    NOT private.safe_skill_file_path(f.file_path) OR octet_length(f.content) > 2097152
    OR f.mime_type !~ '^[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+$' OR length(f.mime_type) > 100)) THEN
    RAISE EXCEPTION 'skill_invalid_files' USING ERRCODE = '22023';
  END IF;
  SELECT count(*), coalesce(sum(octet_length(content)), 0), count(DISTINCT lower(file_path))
    INTO file_count, file_bytes, unique_count FROM public.skill_files WHERE skill_id = p_skill_id;
  IF file_count > 64 OR file_count <> unique_count OR file_bytes + octet_length(s.skill_content) > 8388608 THEN
    RAISE EXCEPTION 'skill_package_budget_or_duplicate' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.guard_skill_row()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.id::text, 913));
  IF TG_OP = 'UPDATE' AND NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'skill_slug_is_immutable' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER skills_stable_slug BEFORE INSERT OR UPDATE ON public.skills
  FOR EACH ROW EXECUTE FUNCTION private.guard_skill_row();

CREATE OR REPLACE FUNCTION private.lock_skill_file_package()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.skill_id IS DISTINCT FROM OLD.skill_id THEN
    RAISE EXCEPTION 'skill_file_cannot_move_packages' USING ERRCODE = '22023';
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(OLD.skill_id::text, 913));
    RETURN OLD;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.skill_id::text, 913));
  RETURN NEW;
END;
$$;
CREATE TRIGGER skill_files_package_lock BEFORE INSERT OR UPDATE OR DELETE ON public.skill_files
  FOR EACH ROW EXECUTE FUNCTION private.lock_skill_file_package();

CREATE OR REPLACE FUNCTION private.check_skill_package_at_commit()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE package_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'skills' THEN package_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN package_id := OLD.skill_id;
  ELSE package_id := NEW.skill_id; END IF;
  -- A deleted package intentionally cascades its files and installations.
  IF EXISTS (SELECT 1 FROM public.skills WHERE id = package_id) THEN
    PERFORM private.assert_skill_package(package_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER skills_complete_package AFTER INSERT OR UPDATE ON public.skills
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.check_skill_package_at_commit();
CREATE CONSTRAINT TRIGGER skill_files_complete_package AFTER INSERT OR UPDATE OR DELETE ON public.skill_files
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.check_skill_package_at_commit();

-- Members may read a private skill installed in their workspace, not arbitrary
-- private registry rows. Mutation stays with its original author.
DROP POLICY skills_select_all ON public.skills;
CREATE POLICY skills_select_all ON public.skills FOR SELECT TO authenticated USING (
  source IN ('system', 'community') OR created_by = auth.uid() OR EXISTS (
    SELECT 1 FROM public.workspace_skills ws WHERE ws.skill_id = skills.id
      AND private.is_workspace_member(ws.workspace_id)
  )
);
DROP POLICY skill_files_select ON public.skill_files;
CREATE POLICY skill_files_select ON public.skill_files FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.skills s WHERE s.id = skill_files.skill_id)
);
DROP POLICY skills_update_user ON public.skills;
CREATE POLICY skills_update_user ON public.skills FOR UPDATE TO authenticated
  USING (source = 'user' AND created_by = auth.uid())
  WITH CHECK (source = 'user' AND created_by = auth.uid());
DROP POLICY ws_skills_update ON public.workspace_skills;
CREATE POLICY ws_skills_update ON public.workspace_skills FOR UPDATE TO authenticated
  USING (private.is_workspace_admin_or_owner(workspace_id))
  WITH CHECK (private.is_workspace_admin_or_owner(workspace_id));

CREATE OR REPLACE FUNCTION private.guard_skill_installation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  -- Invoker visibility rejects guessed IDs of another user's private package.
  -- Disabling an already installed broken package must remain possible.
  IF TG_OP = 'INSERT' OR NEW.enabled OR NEW.skill_id IS DISTINCT FROM OLD.skill_id THEN
    PERFORM private.assert_skill_package(NEW.skill_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_skills_complete_package BEFORE INSERT OR UPDATE ON public.workspace_skills
  FOR EACH ROW EXECUTE FUNCTION private.guard_skill_installation();

CREATE OR REPLACE FUNCTION public.save_skill_package(p_skill_id uuid, p_workspace_id uuid, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE saved public.skills%ROWTYPE; package_id uuid; file_entry jsonb; file_rows jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'skill_invalid_package' USING ERRCODE = '22023';
  END IF;
  IF p_payload ? 'files' AND (jsonb_typeof(p_payload->'files') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_payload->'files') > 64) THEN
    RAISE EXCEPTION 'skill_invalid_files' USING ERRCODE = '22023';
  END IF;
  IF p_skill_id IS NULL THEN
    IF p_workspace_id IS NULL OR NOT private.is_workspace_admin_or_owner(p_workspace_id) THEN
      RAISE EXCEPTION 'workspace_admin_required' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.skills (name, slug, description, category, skill_content, icon_name,
      source, created_by, author, version, license, metadata, source_url, package_name)
    VALUES (p_payload->>'name', p_payload->>'slug', p_payload->>'description', p_payload->>'category',
      p_payload->>'skillContent', p_payload->>'iconName', 'user', auth.uid(),
      coalesce(p_payload->>'author', 'user'), coalesce(p_payload->>'version', '1.0'), p_payload->>'license',
      coalesce(p_payload->'metadata', '{}'::jsonb), p_payload->>'sourceUrl', p_payload->>'packageName')
    RETURNING * INTO saved;
    package_id := saved.id;
  ELSE
    SELECT * INTO saved FROM public.skills WHERE id = p_skill_id AND created_by = auth.uid() AND source = 'user' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'skill_not_found' USING ERRCODE = '22023'; END IF;
    package_id := saved.id;
    UPDATE public.skills SET
      name = CASE WHEN p_payload ? 'name' THEN p_payload->>'name' ELSE name END,
      description = CASE WHEN p_payload ? 'description' THEN p_payload->>'description' ELSE description END,
      category = CASE WHEN p_payload ? 'category' THEN p_payload->>'category' ELSE category END,
      skill_content = CASE WHEN p_payload ? 'skillContent' THEN p_payload->>'skillContent' ELSE skill_content END,
      icon_name = CASE WHEN p_payload ? 'iconName' THEN p_payload->>'iconName' ELSE icon_name END
    WHERE id = package_id RETURNING * INTO saved;
  END IF;
  IF p_payload ? 'files' THEN
    DELETE FROM public.skill_files WHERE skill_id = package_id;
    FOR file_entry IN SELECT value FROM jsonb_array_elements(p_payload->'files') LOOP
      IF jsonb_typeof(file_entry) IS DISTINCT FROM 'object' OR jsonb_typeof(file_entry->'content') IS DISTINCT FROM 'string'
        OR NOT private.safe_skill_file_path(file_entry->>'filePath') THEN
        RAISE EXCEPTION 'skill_invalid_files' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.skill_files (skill_id, file_path, content, mime_type)
        VALUES (package_id, file_entry->>'filePath', file_entry->>'content', coalesce(file_entry->>'mimeType', 'text/plain'));
    END LOOP;
  END IF;
  PERFORM private.assert_skill_package(package_id);
  IF p_skill_id IS NULL THEN
    INSERT INTO public.workspace_skills(workspace_id, skill_id, enabled, installed_by)
      VALUES (p_workspace_id, package_id, true, auth.uid());
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.file_path), '[]'::jsonb) INTO file_rows
    FROM public.skill_files f WHERE f.skill_id = package_id;
  RETURN jsonb_build_object('skill', to_jsonb(saved), 'files', file_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.install_skill_package(p_workspace_id uuid, p_skill_id uuid, p_enabled boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT private.is_workspace_admin_or_owner(p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_admin_required' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'skill_invalid_enabled' USING ERRCODE = '22023'; END IF;
  -- An existing bad package can be disabled without running its instructions.
  IF NOT p_enabled THEN
    UPDATE public.workspace_skills SET enabled = false WHERE workspace_id = p_workspace_id AND skill_id = p_skill_id;
    IF FOUND THEN RETURN; END IF;
  END IF;
  PERFORM private.assert_skill_package(p_skill_id);
  INSERT INTO public.workspace_skills(workspace_id, skill_id, enabled, installed_by)
    VALUES (p_workspace_id, p_skill_id, p_enabled, auth.uid())
    ON CONFLICT (workspace_id, skill_id) DO UPDATE SET enabled = EXCLUDED.enabled;
END;
$$;

REVOKE ALL ON FUNCTION public.save_skill_package(uuid, uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.install_skill_package(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_skill_package(uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.install_skill_package(uuid, uuid, boolean) TO authenticated;
REVOKE ALL ON FUNCTION private.safe_skill_file_path(text), private.assert_skill_package(uuid),
  private.guard_skill_row(), private.lock_skill_file_package(), private.check_skill_package_at_commit(),
  private.guard_skill_installation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.safe_skill_file_path(text), private.assert_skill_package(uuid)
  TO authenticated, service_role;
