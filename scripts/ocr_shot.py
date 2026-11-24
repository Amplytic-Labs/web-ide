#!/usr/bin/env python3
"""OCR a screenshot (upscaled) — helper for verification scripts."""
import sys
import pytesseract
from PIL import Image

im = Image.open(sys.argv[1])
im = im.resize((im.width * 2, im.height * 2), Image.LANCZOS)
print(pytesseract.image_to_string(im))
