\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE canvases, chat_sessions, design_nodes, background_jobs IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE cleanup_canvas_ids AS
SELECT id FROM canvases WHERE created_at < timestamptz '2026-09-10 00:00:00+08';
CREATE TEMP TABLE cleanup_design_ids AS
SELECT DISTINCT n.design_id AS id FROM design_nodes n
WHERE n.canvas_id IN (SELECT id FROM cleanup_canvas_ids)
AND NOT EXISTS (SELECT 1 FROM design_nodes other WHERE other.design_id=n.design_id AND other.canvas_id NOT IN (SELECT id FROM cleanup_canvas_ids));
CREATE TEMP TABLE cleanup_session_ids AS SELECT id FROM chat_sessions WHERE canvas_id IN (SELECT id FROM cleanup_canvas_ids);
CREATE TEMP TABLE cleanup_job_ids AS SELECT id FROM background_jobs WHERE canvas_id IN (SELECT id FROM cleanup_canvas_ids) OR session_id IN (SELECT id FROM cleanup_session_ids) OR design_id IN (SELECT id FROM cleanup_design_ids);
CREATE TEMP TABLE cleanup_preserved AS SELECT
(SELECT count(*) FROM canvases WHERE id NOT IN (SELECT id FROM cleanup_canvas_ids)) AS canvases,
(SELECT count(*) FROM projects) AS projects,
(SELECT count(*) FROM auth.users) AS users,
(SELECT count(*) FROM credit_transactions) AS transactions;
DO $$ BEGIN
IF (SELECT count(*) FROM cleanup_canvas_ids) <> 164 THEN RAISE EXCEPTION 'Canvas target count changed'; END IF;
IF EXISTS(SELECT 1 FROM agent_runs WHERE session_id IN (SELECT id FROM cleanup_session_ids) AND status IN ('running','accepted')) THEN RAISE EXCEPTION 'Active agent run'; END IF;
IF EXISTS(SELECT 1 FROM background_jobs WHERE id IN (SELECT id FROM cleanup_job_ids) AND status NOT IN ('succeeded','canceled','dead_letter','failed')) THEN RAISE EXCEPTION 'Active background job'; END IF;
END $$;
DELETE FROM agent_task_autonomy WHERE canvas_id IN (SELECT id FROM cleanup_canvas_ids);
DELETE FROM background_jobs j WHERE id IN (SELECT id FROM cleanup_job_ids) AND NOT EXISTS(SELECT 1 FROM credit_transactions t WHERE t.job_id=j.id);
-- Maintenance-only: allow FK SET NULL for completed billing records. The table
-- is locked and both immutability guards are restored before commit.
ALTER TABLE background_jobs DISABLE TRIGGER background_jobs_validate_frozen_target;
ALTER TABLE background_jobs DISABLE TRIGGER frozen_image_job_guard;
UPDATE background_jobs SET target_kind=NULL, canvas_id=NULL, design_id=NULL, session_id=NULL
WHERE id IN (SELECT id FROM cleanup_job_ids);
DELETE FROM canvases WHERE id IN (SELECT id FROM cleanup_canvas_ids);
DELETE FROM design_documents WHERE id IN (SELECT id FROM cleanup_design_ids);
ALTER TABLE background_jobs ENABLE TRIGGER frozen_image_job_guard;
ALTER TABLE background_jobs ENABLE TRIGGER background_jobs_validate_frozen_target;
DO $$ BEGIN
IF (SELECT count(*) FROM canvases) <> (SELECT canvases FROM cleanup_preserved)
OR (SELECT count(*) FROM projects) <> (SELECT projects FROM cleanup_preserved)
OR (SELECT count(*) FROM auth.users) <> (SELECT users FROM cleanup_preserved)
OR (SELECT count(*) FROM credit_transactions) <> (SELECT transactions FROM cleanup_preserved)
THEN RAISE EXCEPTION 'Preserved record counts changed'; END IF;
END $$;
SELECT 'deleted_canvases',count(*) FROM cleanup_canvas_ids;
SELECT 'deleted_designs',count(*) FROM cleanup_design_ids;
SELECT 'remaining_canvases',count(*) FROM canvases;
COMMIT;
