"""Fast local mask-contract tests, no model inference or network."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
from PIL import Image
import feynobg_worker as worker


class PointMattingTests(unittest.TestCase):
    def test_original_coordinates_and_alpha_mask(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            image = np.full((4, 6, 4), [20, 40, 80, 128], dtype=np.uint8)
            Image.fromarray(image).save(root / "source.png")
            mask = np.zeros((4, 6), dtype=bool)
            mask[1:3, 2:5] = True
            with patch.object(worker, "make_sam2_mask", return_value=mask) as predict:
                result = worker.point_matting(root, root / "source.png", root, [{"x": .5, "y": .5, "label": 1}])
            self.assertEqual(predict.call_args.kwargs["points"], [[3, 2]])
            self.assertEqual((result["width"], result["height"]), (6, 4))
            out = np.asarray(Image.open(root / result["files"][0]["name"]))
            self.assertEqual(out[2, 3].tolist(), [20, 40, 80, 255])
            self.assertEqual(out[0, 0, 3], 0)

    def test_invalid_points_do_not_load_the_model(self):
        for points in ([], [{"x": .5, "y": .5, "label": 0}], [{"x": 2, "y": .5, "label": 1}]):
            with patch.object(worker, "make_sam2_mask") as predict, self.assertRaises(ValueError):
                worker.point_matting(Path("."), Path("missing"), Path("."), points)
            predict.assert_not_called()

    def test_vision_box_is_combined_with_points(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            Image.new('RGBA', (100, 80), 'red').save(root / 'source.png')
            with patch.object(worker, 'make_sam2_mask', return_value=np.ones((80, 100), dtype=bool)) as predict:
                worker.point_matting(root, root / 'source.png', root,
                    [{'x': .5, 'y': .5, 'label': 1}, {'x': 0, 'y': 0, 'label': 0}],
                    {'x': .1, 'y': .2, 'width': .7, 'height': .6})
            self.assertEqual(predict.call_args.args[2], [10, 16, 80, 64])
            self.assertEqual(predict.call_args.kwargs['labels'], [1, 0])

    def test_invalid_box_is_rejected_before_loading(self):
        with patch.object(worker, 'make_sam2_mask') as predict, self.assertRaises(ValueError):
            worker.point_matting(Path('.'), Path('missing'), Path('.'), [{'x': .5, 'y': .5, 'label': 1}],
                {'x': .8, 'y': .2, 'width': .7, 'height': .6})
        predict.assert_not_called()


if __name__ == "__main__":
    unittest.main()
