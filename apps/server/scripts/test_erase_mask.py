import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image
from feynobg_worker import load_erase_mask, apply_transparent_erase


class EraseMaskTests(unittest.TestCase):
    def test_feather_does_not_change_unselected_pixels(self):
        values = np.zeros((32, 32), dtype=np.uint8)
        values[8:24, 8:24] = 255
        with tempfile.TemporaryDirectory(prefix="loomic-mask-test-") as folder:
            path = Path(folder) / "mask.png"
            Image.fromarray(values).save(path)
            mask = load_erase_mask(path, (32, 32))
        self.assertTrue(np.all(mask[values == 0] == 0))
        source = Image.new("RGBA", (32, 32), (30, 80, 120, 255))
        output = apply_transparent_erase(source, mask)
        self.assertTrue(np.all(output[values == 0] == np.asarray(source)[values == 0]))
        self.assertEqual(int(output[16, 16, 3]), 0)


if __name__ == "__main__":
    unittest.main()
