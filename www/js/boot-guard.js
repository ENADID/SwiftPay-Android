/*
 * SwiftPay — boot-guard.js
 * حماية من الشاشة البيضاء (White Screen Prevention)
 *
 * يُحمَّل قبل app.js ويقوم بـ:
 * 1) التقاط أي خطأ JavaScript غير معالج (error / unhandledrejection) وعرض
 *    شاشة خطأ واضحة بدل بقاء الشاشة بيضاء.
 * 2) التأكد من أن التطبيق أقلع فعلياً بعد التحميل، وإلا عرض شاشة الاسترجاع.
 * 3) توفير مسار احتياطي (404) لأي شاشة/تبويب غير معروف بدل انهيار العرض.
 */
(function () {
  'use strict';

  var shown = false;
  var LOG_KEY = 'swiftpay_boot_log';

  // سجل أخطاء الإقلاع محفوظ بالجهاز (آخر 15 سطراً) مع معلومات البيئة، لتشخيص الشاشة البيضاء
  function envInfo() {
    var cs = false;
    try { cs = !!(window.CSS && CSS.supports && CSS.supports('background', 'color-mix(in srgb, red 50%, blue)')); } catch (e) {}
    return {
      ua: navigator.userAgent,
      secureContext: !!window.isSecureContext,
      cryptoSubtle: !!(window.crypto && window.crypto.subtle),
      capacitor: !!window.Capacitor,
      colorMix: cs,
      viewport: window.innerWidth + 'x' + window.innerHeight
    };
  }
  function readLog() {
    try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { return []; }
  }
  function logBoot(kind, msg) {
    try {
      var a = readLog();
      a.push({ t: new Date().toISOString(), k: kind, m: String(msg).slice(0, 300) });
      localStorage.setItem(LOG_KEY, JSON.stringify(a.slice(-15)));
    } catch (e) {}
  }
  window.SwiftPayBootLog = { read: readLog, env: envInfo };

  function renderFallback(title, detail) {
    if (shown) return;
    shown = true;
    try {
      var lock = document.getElementById('applock-screen');
      if (lock) lock.style.display = 'none';
    } catch (e) {}

    var box = document.createElement('div');
    box.id = 'swiftpay-fallback-screen';
    box.setAttribute('dir', 'rtl');
    box.style.cssText =
      'position:fixed;top:0;right:0;bottom:0;left:0;inset:0;z-index:99999;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;' +
      'background:#080D1A;color:#E8EDF7;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;';

    var h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'font-size:19px;font-weight:700;';

    var p = document.createElement('div');
    p.textContent = detail;
    p.style.cssText = 'font-size:14px;line-height:1.7;opacity:.75;max-width:340px;';

    var reload = document.createElement('button');
    reload.textContent = 'إعادة تشغيل التطبيق';
    reload.style.cssText =
      'margin-top:6px;padding:12px 22px;border:0;border-radius:12px;cursor:pointer;' +
      'background:#3DA877;color:#04140C;font-size:15px;font-weight:700;';
    reload.onclick = function () {
      location.reload();
    };

    var reset = document.createElement('button');
    reset.textContent = 'تفريغ الذاكرة المؤقتة وإعادة المحاولة';
    reset.style.cssText =
      'padding:10px 18px;border:1px solid rgba(255,255,255,.18);border-radius:12px;' +
      'cursor:pointer;background:transparent;color:#E8EDF7;font-size:13px;';
    reset.onclick = function () {
      try {
        if (window.caches && caches.keys) {
          caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (k) { return caches.delete(k); }));
          }).then(function () { location.reload(true); });
          return;
        }
      } catch (e) {}
      location.reload(true);
    };

    var info = document.createElement('pre');
    try {
      var lg = readLog().slice(-3).map(function (x) { return x.k + ': ' + x.m; });
      info.textContent = JSON.stringify(envInfo(), null, 1) + (lg.length ? '\n' + lg.join('\n') : '');
    } catch (e) { info.textContent = ''; }
    info.setAttribute('dir', 'ltr');
    info.style.cssText = 'margin:0;max-width:340px;max-height:160px;overflow:auto;text-align:left;font-size:10px;line-height:1.4;opacity:.55;white-space:pre-wrap;word-break:break-all;';

    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(info);
    box.appendChild(reload);
    box.appendChild(reset);
    (document.body || document.documentElement).appendChild(box);
  }

  window.SwiftPayFallback = renderFallback;

  window.addEventListener('error', function (event) {
    var msg = (event && event.message) || 'خطأ غير معروف';
    console.error('SwiftPay error:', event && (event.error || msg));
    logBoot('error', msg + (event && event.filename ? ' @' + event.filename + ':' + event.lineno : ''));
    renderFallback('تعذّر تشغيل الشاشة', 'حدث خطأ غير متوقع: ' + msg);
  });

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    console.error('SwiftPay rejection:', reason);
    logBoot('rejection', (reason && reason.message) || reason || 'unknown');
    renderFallback(
      'تعذّر إكمال العملية',
      'حدث خطأ غير متوقع: ' + ((reason && reason.message) || reason || 'غير معروف')
    );
  });

  // فشل تحميل ملف أساسي (سكربت/ستايل): يُسجَّل، وسكربتات التطبيق تُظهر شاشة الاسترجاع
  window.addEventListener('error', function (event) {
    var t = event && event.target;
    if (!t || t === window || !t.tagName) return;
    var url = t.src || t.href || '';
    logBoot('resource', t.tagName + ' ' + url);
    if (t.tagName === 'SCRIPT') {
      renderFallback('تعذّر تحميل ملف التطبيق', 'ملف لم يُحمَّل: ' + url.split('/').pop());
    }
  }, true);

  // ------- مراقب اكتمال الإقلاع: app.js يضبط __swiftpayBooted عند انتهاء بدء التشغيل -------
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (!window.__swiftpayBooted) {
        logBoot('watchdog', 'boot not completed 5s after load');
        renderFallback('لم يكتمل تشغيل التطبيق', 'توقف بدء التشغيل قبل اكتماله. جرّب إعادة التشغيل أو تفريغ الذاكرة المؤقتة.');
      }
    }, 5000);
  });

  // ------- التحقق من إقلاع الواجهة فعلياً (لا شاشة بيضاء صامتة) -------
  window.addEventListener('load', function () {
    setTimeout(function () {
      var app = document.querySelector('.mobile-app');
      var visible = app && app.offsetHeight > 0;
      if (!visible) {
        renderFallback(
          'لم يتم تحميل الواجهة',
          'تعذّر عرض واجهة التطبيق. جرّب إعادة التشغيل أو تفريغ الذاكرة المؤقتة.'
        );
      }
    }, 1200);
  });

  // ------- مسار احتياطي (404) لأي شاشة غير معروفة -------
  var KNOWN_VIEWS = ['home', 'wizard', 'history', 'favorites', 'settings'];

  window.addEventListener('load', function () {
    if (typeof window.switchTab !== 'function') return;
    var original = window.switchTab;
    window.switchTab = function (tabName) {
      try {
        if (KNOWN_VIEWS.indexOf(tabName) === -1) {
          console.warn('SwiftPay: شاشة غير معروفة =', tabName, '— تم التحويل للرئيسية');
          return original('home');
        }
        return original.apply(this, arguments);
      } catch (err) {
        console.error(err);
        renderFallback('تعذّر فتح الشاشة', 'حدث خطأ أثناء فتح الشاشة المطلوبة.');
      }
    };
  });
})();
