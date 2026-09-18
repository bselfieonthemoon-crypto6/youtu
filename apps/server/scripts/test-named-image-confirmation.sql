-- Read-only assertions against the actual deployed SQL billing boundary.
BEGIN;
DO $$
DECLARE sample text;
BEGIN
  IF private.loomic_classify_image_message('确认生成这张山岚海报。') <> 'confirm' THEN RAISE EXCEPTION 'Named confirmation lost'; END IF;
  IF NOT private.loomic_image_confirmation_matches_proposal('确认生成这张山岚海报。',jsonb_build_object('title','澄屿 海报「山岚」4:5')) THEN RAISE EXCEPTION 'Matching title rejected'; END IF;
  IF private.loomic_image_confirmation_matches_proposal('确认生成这张山岚海报。',jsonb_build_object('title','澄屿 晚晴海报')) THEN RAISE EXCEPTION 'Wrong title authorized'; END IF;
  IF private.loomic_image_confirmation_matches_proposal('确认生成这张山岚海报。','{}'::jsonb) THEN RAISE EXCEPTION 'Missing title authorized'; END IF;
  IF private.loomic_classify_image_message('确认生成这张暖橙改色版海报。') <> 'confirm' THEN RAISE EXCEPTION 'Revision label confirmation lost'; END IF;
  IF NOT private.loomic_image_confirmation_matches_proposal(
    '确认生成这张暖橙改色版海报。',jsonb_build_object('title','澄屿「晚晴」海报·暖橙改色版（4:5）')
  ) THEN RAISE EXCEPTION 'Matching revision label rejected'; END IF;
  IF private.loomic_image_confirmation_matches_proposal(
    '确认生成这张暖橙改色版海报。',jsonb_build_object('title','澄屿「晚晴」海报·深蓝版（4:5）')
  ) THEN RAISE EXCEPTION 'Wrong revision label authorized'; END IF;
  IF private.loomic_classify_image_message('重新生成，还是刚才确认的山岚海报，比例4:5，其他不变。') <> 'confirm' THEN RAISE EXCEPTION 'Named retry confirmation lost'; END IF;
  IF NOT private.loomic_image_confirmation_matches_proposal(
    '重新生成，还是刚才确认的山岚海报，比例4:5，其他不变。',
    jsonb_build_object('title','澄屿 海报「山岚」4:5','aspectRatio','4:5')
  ) THEN RAISE EXCEPTION 'Matching named retry rejected'; END IF;
  IF private.loomic_image_confirmation_matches_proposal(
    '重新生成，还是刚才确认的山岚海报，比例4:5，其他不变。',
    jsonb_build_object('title','澄屿 晚晴海报','aspectRatio','4:5')
  ) THEN RAISE EXCEPTION 'Wrong retry title authorized'; END IF;
  IF private.loomic_image_confirmation_matches_proposal(
    '重新生成，还是刚才确认的山岚海报，比例4:5，其他不变。',
    jsonb_build_object('title','澄屿 山岚海报','aspectRatio','16:9')
  ) THEN RAISE EXCEPTION 'Wrong retry ratio authorized'; END IF;
  IF private.loomic_image_confirmation_matches_proposal(
    '重新生成，还是刚才确认的山岚海报，比例4:5，其他不变。',
    jsonb_build_object('title','澄屿 山岚海报')
  ) THEN RAISE EXCEPTION 'Missing retry ratio authorized'; END IF;
  FOREACH sample IN ARRAY ARRAY['确认生成这张山岚海报？','如果免费确认生成这张山岚海报','确认生成这张山岚海报，另外改成蓝色','确认生成这张山岚两张海报','确认生成这张山岚改成蓝色海报'] LOOP
    IF private.loomic_classify_image_message(sample)='confirm' THEN RAISE EXCEPTION 'Unsafe approval: %',sample; END IF;
  END LOOP;
  FOREACH sample IN ARRAY ARRAY[
    '重新生成，还是刚才确认的山岚海报，比例4:5，其他不变？',
    '如果免费，重新生成还是刚才确认的山岚海报，比例4:5，其他不变',
    '重新生成，还是刚才确认的山岚海报，比例4:5，另外改文案',
    '重新生成，还是刚才确认的山岚海报，比例4:5，其他不变，生成两张',
    '重新生成刚才确认的山岚海报，其他不变'
  ] LOOP
    IF private.loomic_classify_image_message(sample)='confirm' THEN RAISE EXCEPTION 'Unsafe retry approval: %',sample; END IF;
  END LOOP;
  IF NOT private.loomic_image_confirmation_matches_proposal('确认生成','{}'::jsonb) THEN RAISE EXCEPTION 'Generic confirmation regressed'; END IF;
  IF NOT private.loomic_is_combined_current_image_confirmation(
    '把刚刚生成的晚晴海报里的深蓝色改成暖橙色，文字、叶片水波图形、米白底和4:5比例都保持不变。确认，按这次修改生成。'
  ) THEN RAISE EXCEPTION 'Combined current-run confirmation lost'; END IF;
  IF private.loomic_classify_image_message(
    '把刚刚生成的晚晴海报里的深蓝色改成暖橙色，文字、叶片水波图形、米白底和4:5比例都保持不变。确认，按这次修改生成。'
  ) <> 'change' THEN RAISE EXCEPTION 'Combined request was broadened into ordinary confirmation'; END IF;
  FOREACH sample IN ARRAY ARRAY[
    '把深蓝色改成暖橙色。确认，按这次修改生成？',
    '如果免费，把深蓝色改成暖橙色。确认，按这次修改生成。',
    '把深蓝色改成暖橙色。确认生成。',
    '保持原方案。确认，按这次修改生成。',
    '确认，按这次修改生成。'
  ] LOOP
    IF private.loomic_is_combined_current_image_confirmation(sample) THEN RAISE EXCEPTION 'Unsafe combined approval: %',sample; END IF;
  END LOOP;
END $$;
ROLLBACK;
