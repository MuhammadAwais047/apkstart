# -*- coding: utf-8 -*-
"""Generate ApkStart WeChat / Douyin promo artwork (Pillow, no third-party service deps)"""
import os
import qrcode
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
IMG = os.path.join(ROOT, 'docs', 'images')
OUT = os.path.join(ROOT, 'docs', 'promo', 'assets')
os.makedirs(OUT, exist_ok=True)

FONT_B = 'C:/Windows/Fonts/msyhbd.ttc'
FONT_R = 'C:/Windows/Fonts/msyh.ttc'
BG = (13, 17, 23)
PANEL = (22, 30, 38)
GREEN = (61, 220, 132)
WHITE = (240, 246, 242)
MUTED = (148, 163, 174)
INK = (9, 22, 15)


def font(size, bold=False):
    return ImageFont.truetype(FONT_B if bold else FONT_R, size)


def grad(w, h, top=(13, 17, 23), bottom=(18, 38, 28)):
    im = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(im)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return im


def wrap(draw, text, f, max_w):
    """Word-aware wrap; a single word wider than max_w is hard-broken by character."""
    lines = []
    for para in text.split('\n'):
        cur = ''
        for word in para.split(' '):
            cand = (cur + ' ' + word) if cur else word
            if draw.textlength(cand, font=f) <= max_w:
                cur = cand
                continue
            if cur:
                lines.append(cur)
                cur = ''
            for ch in word:
                if draw.textlength(cur + ch, font=f) > max_w and cur:
                    lines.append(cur)
                    cur = ch
                else:
                    cur += ch
        lines.append(cur)
    return lines


def text_block(draw, xy, text, size, color, max_w, bold=False, spacing=12):
    f = font(size, bold)
    x, y = xy
    for line in wrap(draw, text, f, max_w):
        draw.text((x, y), line, font=f, fill=color)
        y += size + spacing
    return y


def rounded(im, box, radius, fill, outline=None, width=1):
    d = ImageDraw.Draw(im)
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def pill(im, xy, text, size, fg, bg, pad_x=24, pad_y=13):
    """Pill sized to its text, so translated copy cannot overflow a fixed-width chip."""
    d = ImageDraw.Draw(im)
    f = font(size, True)
    x, y = xy
    w = int(d.textlength(text, font=f)) + 2 * pad_x
    h = size + 2 * pad_y
    rounded(im, (x, y, x + w, y + h), h // 2, fill=bg)
    d.text((x + pad_x, y + pad_y), text, font=f, fill=fg)
    return x + w


def paste_fit(canvas, img, box, radius=0):
    """Scale proportionally and center-fit into the box"""
    x, y, w, h = box
    r = min(w / img.width, h / img.height)
    im = img.resize((int(img.width * r), int(img.height * r)), Image.LANCZOS)
    px, py = x + (w - im.width) // 2, y + (h - im.height) // 2
    if radius and im.mode == 'RGB':
        mask = Image.new('L', im.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, im.width - 1, im.height - 1), radius=radius, fill=255)
        canvas.paste(im, (px, py), mask)
    else:
        canvas.paste(im, (px, py), im.getchannel('A') if im.mode == 'RGBA' else None)
    return (px, py, im.width, im.height)


def qr_png(url, size=520):
    qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=12, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    im = qr.make_image(fill_color='#0d1117', back_color='white').convert('RGB')
    return im.resize((size, size), Image.LANCZOS)


LOGO = Image.open(os.path.join(IMG, 'logo.png')).convert('RGB')
APP = Image.open(os.path.join(IMG, 'app.png')).convert('RGB')
HONGGUO = Image.open(os.path.join(IMG, 'compat-hongguo-playing.png')).convert('RGB')
BRAND = Image.open(os.path.join(IMG, 'brand.png')).convert('RGB')
RELEASE = 'https://github.com/RoutineMiku/apkstart/releases/tag/v0.2.2'


# ---------- WeChat article cover 900x383 ----------
def cover():
    im = grad(900, 383, (13, 17, 23), (16, 40, 28))
    d = ImageDraw.Draw(im)
    # background halo
    glow = Image.new('RGBA', (900, 383), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-120, 180, 420, 620), fill=(61, 220, 132, 28))
    glow = glow.filter(ImageFilter.GaussianBlur(60))
    im = Image.alpha_composite(im.convert('RGBA'), glow).convert('RGB')
    d = ImageDraw.Draw(im)
    paste_fit(im, LOGO, (36, 60, 262, 262), radius=34)
    text_block(d, (330, 78), 'ApkStart', 62, WHITE, 540, bold=True, spacing=0)
    text_block(d, (334, 158), 'Double-click .apk, run Android apps', 26, GREEN, 530, bold=True)
    text_block(d, (334, 214), 'Open source · free · standalone windows · ARM ready', 20, MUTED, 530)
    pill(im, (334, 274), 'v0.2.2 · full build, ready to run', 22, INK, GREEN)
    im.save(os.path.join(OUT, 'wechat-cover.jpg'), quality=94)
    return im


# ---------- QR codes for the download page ----------
def download_qr():
    """For the article body: two QR codes, each linking straight to one installer (scan to download)"""
    im = Image.new('RGB', (1080, 700), (247, 250, 248))
    d = ImageDraw.Draw(im)
    rounded(im, (24, 24, 1056, 676), 28, fill=(255, 255, 255), outline=(222, 232, 226), width=2)
    d.text((60, 52), 'Scan to download ApkStart v0.2.2', font=font(40, True), fill=(13, 17, 23))
    d.text((62, 110), 'Long-press a code in WeChat, or tap "Read more" at the end', font=font(24), fill=(100, 118, 108))
    cards = [
        (60, 'Lite · 0.11 GB', 'ApkStart-v0.2.2-win64-portable.zip', 'One-click setup, about 2 min'),
        (560, 'Full · 1.35 GB', 'ApkStart-v0.2.2-win64-full.7z.001', 'Engine + image bundled, unzip and run'),
    ]
    for x, name, asset, tip in cards:
        rounded(im, (x, 170, x + 460, 636), 24, fill=(246, 250, 247), outline=(222, 232, 226), width=2)
        d.text((x + 26, 192), name, font=font(30, True), fill=(13, 17, 23))
        url = f'https://github.com/RoutineMiku/apkstart/releases/download/v0.2.2/{asset}'
        paste_fit(im, qr_png(url, 360), (x + 50, 240, 360, 360))
        d.text((x + 26, 608), tip, font=font(22), fill=(80, 100, 90))
    im.save(os.path.join(OUT, 'download-qr.png'))
    return im


# ---------- Douyin vertical carousel 1080x1440 ----------
W, H = 1080, 1440


def douyin_base(idx, title, subtitle=None):
    im = grad(W, H, (11, 15, 20), (14, 34, 24))
    d = ImageDraw.Draw(im)
    # top brand bar
    paste_fit(im, LOGO, (64, 62, 92, 92), radius=20)
    d.text((178, 78), 'ApkStart', font=font(38, True), fill=WHITE)
    d.text((178, 126), 'Powered by RoutineMiku', font=font(22), fill=MUTED)
    # page number
    d.text((930, 80), f'{idx}/5', font=font(30, True), fill=GREEN)
    y = text_block(d, (64, 232), title, 62, WHITE, 950, bold=True, spacing=14)
    if subtitle:
        text_block(d, (64, y + 20), subtitle, 30, GREEN, 950)
    return im, d


def dy1():
    im, d = douyin_base(1, 'Double-click .apk\nrun Android on your PC', 'No emulator to install, nothing to configure')
    # large logo centered
    paste_fit(im, LOGO, (290, 560, 500, 500), radius=70)
    pill(im, (190, 1110), 'Open source · free · no install', 38, INK, GREEN)
    text_block(d, (64, 1250), 'The lightest Android launcher for Windows', 32, MUTED, 950)
    im.save(os.path.join(OUT, 'douyin-1.png'))
    return im


def dy2():
    im, d = douyin_base(2, 'Running an Android app\nused to be painful')
    items = [
        ('Slow download', 'A multi-GB emulator, half an afternoon wasted'),
        ("Won't install", 'ARM apps fail with NO_MATCHING_ABIS'),
        ('Bloated', 'Fans take off, pop-up ads everywhere'),
    ]
    y = 540
    for t, sub in items:
        rounded(im, (64, y, 1016, y + 210), 28, fill=PANEL, outline=(48, 66, 58), width=2)
        d.text((110, y + 34), '×', font=font(64, True), fill=(240, 96, 96))
        d.text((190, y + 30), t, font=font(44, True), fill=WHITE)
        d.text((190, y + 108), sub, font=font(30), fill=MUTED)
        y += 240
    text_block(d, (64, 1300), 'So I wrote my own: ApkStart', 40, GREEN, 950, bold=True)
    im.save(os.path.join(OUT, 'douyin-2.png'))
    return im


def dy3():
    im, d = douyin_base(3, 'Four features, ready to go')
    feats = [
        ('Double-click install', 'Associate .apk: install on double-click, shortcut added'),
        ('Standalone window', 'One resizable window per app, fully independent'),
        ('Shared folder', 'Host and Android share a folder - just drag files in'),
        ('Official engine', 'Google Android Emulator + AEHD acceleration'),
    ]
    y = 470
    for i, (t, sub) in enumerate(feats):
        rounded(im, (64, y, 1016, y + 160), 26, fill=PANEL)
        rounded(im, (92, y + 34, 172, y + 114), 20, fill=(61, 220, 132))
        d.text((112, y + 48), f'0{i+1}', font=font(36, True), fill=INK)
        d.text((210, y + 24), t, font=font(40, True), fill=WHITE)
        d.text((210, y + 90), sub, font=font(27), fill=MUTED)
        y += 180
    rounded(im, (64, 1200, 1016, 1330), 28, fill=(20, 48, 33), outline=GREEN, width=2)
    d.text((100, 1222), 'Turn on ARM compat mode in settings', font=font(38, True), fill=GREEN)
    d.text((100, 1280), 'ARM-only apps install and run too', font=font(26), fill=MUTED)
    im.save(os.path.join(OUT, 'douyin-3.png'))
    return im


def dy4():
    im, d = douyin_base(4, 'ARM / ByteDance apps\nnow really run', 'Android 14 image with the new translation layer')
    paste_fit(im, HONGGUO, (330, 470, 420, 760), radius=30)
    rounded(im, (64, 1250, 1016, 1360), 28, fill=PANEL)
    text_block(d, (100, 1266), 'Hongguo: install, feed, video - no crashes', 30, GREEN, 890, bold=True)
    im.save(os.path.join(OUT, 'douyin-4.png'))
    return im


def dy5():
    im, d = douyin_base(5, 'Two editions, pick one', 'Full edition: unzip and run, zero downloads')
    rounded(im, (64, 460, 1016, 660), 30, fill=PANEL)
    text_block(d, (100, 486), 'Lite  0.11 GB', 40, WHITE, 880, bold=True)
    text_block(d, (100, 548), 'One-click setup on first start: engine and image in ~2 min', 28, MUTED, 880)
    rounded(im, (64, 690, 1016, 910), 30, fill=(20, 48, 33), outline=GREEN, width=2)
    text_block(d, (100, 716), 'Full  1.35 GB  ★ recommended', 40, GREEN, 880, bold=True)
    text_block(d, (100, 778), 'Engine + AEHD + Android 14 compat image (translation layer)', 28, WHITE, 880)
    text_block(d, (100, 826), 'Unzip, run ApkStart.exe, straight to the main screen', 28, MUTED, 880)
    paste_fit(im, qr_png(RELEASE, 400), (64, 950, 400, 400))
    text_block(d, (510, 990), 'Scan to download', 46, WHITE, 500, bold=True)
    text_block(d, (510, 1060), 'Search GitHub\nRoutineMiku/apkstart', 30, MUTED, 500, spacing=6)
    text_block(d, (510, 1170), 'Douyin @日常MIKU', 34, GREEN, 500, bold=True)
    text_block(d, (510, 1224), 'WeChat QR on the profile page', 28, MUTED, 500)
    im.save(os.path.join(OUT, 'douyin-5.png'))
    return im


if __name__ == '__main__':
    cover()
    download_qr()
    dy1(); dy2(); dy3(); dy4(); dy5()
    for f in sorted(os.listdir(OUT)):
        print(' ', f, os.path.getsize(os.path.join(OUT, f)) // 1024, 'KB')
