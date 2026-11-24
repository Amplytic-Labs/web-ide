#!/usr/bin/env python3
"""Generate Nodine-branded icons for the web IDE build:
favicon.ico + code-192.png + code-512.png, from assets/Nodine-logo.svg (brand green #61E925).
The logo is a white mark + #61E925 accents on transparent, so icons get a
dark background (VS Code dark #1e1e1e family) for contrast.
No theme change — icons only.
"""
import io
import subprocess

SRC_SVG = '/home/z/my-project/web-ide-repo/assets/Nodine-logo.svg'
SRC_PNG = '/home/z/my-project/web-ide-repo/assets/Nodine-logo.png'
OUT = '/home/z/my-project/web-ide-repo/vscode-web'

BG = (23, 23, 29, 255)          # dark charcoal, matches workbench dark bg
PAD = 0.10                       # 10% padding around the mark


def render(size):
    """Render the SVG logo at `size` via rsvg-convert or cairosvg fallback."""
    try:
        p = subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size), SRC_SVG],
                           capture_output=True, check=True)
        return p.stdout
    except (FileNotFoundError, subprocess.CalledProcessError):
        import cairosvg
        return cairosvg.svg2png(url=SRC_SVG, output_width=size, output_height=size)


def compose(size, bg=BG):
    from PIL import Image
    icon = Image.new('RGBA', (size, size), bg)
    logo = Image.open(io.BytesIO(render(size))).convert('RGBA')

    # scale logo to fit with padding
    inner = int(size * (1 - 2 * PAD))
    logo = logo.resize((inner, inner), Image.LANCZOS)
    off = (size - inner) // 2
    icon.alpha_composite(logo, (off, off))
    return icon


def main():
    import os

    # 192 and 512 PWA icons
    for s in (192, 512):
        img = compose(s)
        img = img.convert('RGB')  # manifest icons don't need alpha
        path = f'{OUT}/code-{s}.png'
        img.save(path, 'PNG', optimize=True)
        print('wrote', path, img.size)

    # favicon: multi-size ICO — save from the largest frame; PIL resizes into each listed size
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48)]
    ico_path = f'{OUT}/favicon.ico'
    compose(48).save(ico_path, format='ICO', sizes=sizes)
    print('wrote', ico_path)

    # brand asset copies into the built site
    import shutil
    dest_dir = '/home/z/my-project/web-ide-repo/vscode-web'
    os.makedirs(dest_dir, exist_ok=True)
    for name in ('Nodine-logo.svg', 'Nodine-logo.png', 'Nodine-text-logo.svg'):
        src = f'/home/z/my-project/web-ide-repo/assets/{name}'
        if os.path.exists(src):
            shutil.copy2(src, f'{dest_dir}/{name}')
            print('copied to', f'{dest_dir}/{name}')

    # verify non-blank
    from PIL import Image
    for f in (f'{OUT}/code-192.png', f'{OUT}/code-512.png'):
        im = Image.open(f).convert('L')
        h = im.histogram()
        print(f, 'non-white ratio', round(1 - h[255] / sum(h), 3))


if __name__ == '__main__':
    main()
