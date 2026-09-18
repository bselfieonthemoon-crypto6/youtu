import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
from PIL import Image
import birefnet_dynamic_matting as dynamic
import feynobg_worker as worker


class DynamicMattingTests(unittest.TestCase):
    def test_shape_preserved_and_bounded(self):
        self.assertEqual(dynamic.inference_size((719, 1280)), (576, 1024))
        self.assertEqual(dynamic.inference_size((1024, 1024)), (1024, 1024))
        self.assertEqual(dynamic.inference_size((1, 5)), (32, 32))

    def test_rgb_and_existing_transparency_preserved(self):
        pixels = np.array([[[10, 20, 30, 0], [40, 50, 60, 100], [70, 80, 90, 255]]], dtype=np.uint8)
        result = np.asarray(dynamic.apply_alpha(Image.fromarray(pixels), np.array([[255, 200, 50]], dtype=np.uint8)))
        np.testing.assert_array_equal(result[:, :, :3], pixels[:, :, :3])
        self.assertEqual(result[:, :, 3].tolist(), [[0, 100, 50]])

    def test_switch_uses_dynamic_and_reports_actual_model(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with patch.dict(os.environ, {"LOOMIC_BACKGROUND_REMOVAL_MODEL": "birefnet-dynamic-matting"}), patch.object(dynamic, "make_cutout", return_value=Image.new("RGBA", (8, 6))) as predict, patch.object(worker, "make_cutout") as legacy:
                result = worker.remove_background(root, root / "input.png", root)
                self.assertEqual(result["model"], "local:birefnet-dynamic-matting")
                self.assertEqual((result["width"], result["height"]), (8, 6))
                predict.assert_called_once()
                legacy.assert_not_called()

    def test_rollback_and_unknown_model(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with patch.dict(os.environ, {"LOOMIC_BACKGROUND_REMOVAL_MODEL": "feynobg"}), patch.object(worker, "make_cutout", return_value=Image.new("RGBA", (8, 6))):
                self.assertEqual(worker.remove_background(root, root / "input.png", root)["model"], "local:feynobg")
            with patch.dict(os.environ, {"LOOMIC_BACKGROUND_REMOVAL_MODEL": "typo"}), self.assertRaises(ValueError):
                worker.remove_background(root, root / "input.png", root)

    def test_background_removal_releases_unused_selection_and_inpainting_models(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with patch.dict(os.environ, {"LOOMIC_BACKGROUND_REMOVAL_MODEL": "birefnet-dynamic-matting"}), patch.object(dynamic, "make_cutout", return_value=Image.new("RGBA", (8, 6))), patch.object(worker, "_sam_runtime", object()), patch.object(worker, "_sam_image_cache", object()), patch.object(worker, "_lama_session", object()):
                worker.remove_background(root, root / "input.png", root)
                self.assertIsNone(worker._sam_runtime)
                self.assertIsNone(worker._sam_image_cache)
                self.assertIsNone(worker._lama_session)

    def test_split_layers_does_not_use_new_background_remover(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with patch.dict(os.environ, {"LOOMIC_BACKGROUND_REMOVAL_MODEL": "birefnet-dynamic-matting"}), patch.object(worker, "split_layers", return_value={"files": []}) as split, patch.object(dynamic, "make_cutout") as predict:
                worker.handle({"id": "test", "input_path": str(root / "source.png"), "output_dir": str(root), "mode": "split_layers"}, root, root / "lama", root)
                split.assert_called_once()
                predict.assert_not_called()


if __name__ == "__main__":
    unittest.main()
