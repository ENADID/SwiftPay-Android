#!/usr/bin/env python3
"""
تنزيل خط Cairo (400/500/600/700) من Google Fonts أثناء البناء وحفظه داخل www/assets/fonts
ليُضمَّن في التطبيق ويعمل بدون إنترنت. لا يُحمَّل أي شيء من الإنترنت عند تشغيل التطبيق.

- يستخدم مكتبات بايثون القياسية فقط (بدون تبعيات).
- يتخطى الملفات الموجودة أصلاً، فإن أضفتها يدوياً لا يُعاد تنزيلها.
- أي فشل لا يوقف البناء: يبقى الخط الاحتياطي (IBM Plex Sans Arabic) ويُطبع تحذير.
"""
import os
import re
import sys
import urllib.request

FONTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'www', 'assets', 'fonts')
WEIGHTS = {400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold'}
CSS_URL = 'https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700&display=swap'
TTF_MAGICS = (b'\x00\x01\x00\x00', b'true', b'OTTO')


def http_get(url):
    # User-Agent قديم عمداً: Google يعيد حينها روابط TTF كاملة بدل woff2 مجزّأة
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/4.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def parse_css(css):
    """يعيد {weight: url} لكل وزن، أو يرفع ValueError إن كان الشكل غير متوقع."""
    found = {}
    for block in re.findall(r'@font-face\s*\{(.*?)\}', css, re.S):
        w = re.search(r'font-weight:\s*(\d+)', block)
        u = re.search(r'url\((https://[^)]+)\)', block)
        if not w or not u:
            continue
        if 'unicode-range' in block:
            raise ValueError('الرد مجزّأ بـ unicode-range (ليس ملف TTF كاملاً)')
        weight = int(w.group(1))
        if weight in found:
            raise ValueError('أكثر من ملف لنفس الوزن %d' % weight)
        found[weight] = u.group(1)
    missing = [w for w in WEIGHTS if w not in found]
    if missing:
        raise ValueError('أوزان ناقصة: %s' % missing)
    return found


def main():
    os.makedirs(FONTS_DIR, exist_ok=True)
    need = {w: n for w, n in WEIGHTS.items()
            if not os.path.isfile(os.path.join(FONTS_DIR, 'Cairo-%s.ttf' % n))}
    if not need:
        print('Cairo: كل الملفات موجودة، لا حاجة للتنزيل')
        return 0
    try:
        urls = parse_css(http_get(CSS_URL).decode('utf-8'))
        for weight, name in need.items():
            data = http_get(urls[weight])
            if len(data) < 30000 or data[:4] not in TTF_MAGICS:
                raise ValueError('ملف غير صالح للوزن %d (الحجم %d)' % (weight, len(data)))
            with open(os.path.join(FONTS_DIR, 'Cairo-%s.ttf' % name), 'wb') as f:
                f.write(data)
            print('Cairo: تم حفظ Cairo-%s.ttf (%d بايت)' % (name, len(data)))
    except Exception as e:  # noqa: BLE001
        print('تحذير: تعذّر تنزيل Cairo (%s). سيبقى الخط الاحتياطي.' % e)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
