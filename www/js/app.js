/*
 * SwiftPay — app.js
 * منطق التطبيق الكامل: توليد أكواد USSD، السجل، المفضلة، قفل التطبيق بالرمز السري،
 * الإعدادات، والتخزين المحلي الدائم عبر localStorage (لا اتصال بأي خادم إطلاقاً)
 */

let currentService = 'jawwal';
let currentType = 'friend';

// ---------- تخزين محلي دائم (يعمل بلا إنترنت، يبقى بعد إغلاق التطبيق) ----------
const STORAGE_KEYS = {
  tx: 'swiftpay_transactions',
  fav: 'swiftpay_favorites',
  settings: 'swiftpay_settings',
  pins: 'swiftpay_pins',
  applock: 'swiftpay_applock'
};

function loadFromStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function saveToStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('SwiftPay: تعذر حفظ البيانات محلياً', e);
  }
}

// ---------- ترحيل سجل العمليات القديم لعدم فقدان أي بيانات ----------
// السجل الآن سجل تنفيذ فقط: لا يحمل أي حالة نجاح/فشل/معالجة. أي حقول قديمة
// كانت تخدم آلية التحقق المحذوفة (status, errorMessage, verifiedBy,
// nativeResponse, timedOut) تُزال هنا نهائياً بدل تركها بيانات ميتة بالتخزين.
function migrateTransactions(list) {
  let changed = false;
  const DEAD_FIELDS = ['status', 'errorMessage', 'verifiedBy', 'nativeResponse', 'timedOut'];
  const migrated = (Array.isArray(list) ? list : []).map(tx => {
    const t = Object.assign({}, tx);
    if (!t.timestamp) { t.timestamp = (typeof t.id === 'number') ? t.id : Date.now(); changed = true; }
    if (t.code === undefined) { t.code = null; changed = true; }
    if ('time' in t) { delete t.time; changed = true; }
    DEAD_FIELDS.forEach(f => { if (f in t) { delete t[f]; changed = true; } });
    return t;
  });
  if (changed) saveToStorage(STORAGE_KEYS.tx, migrated);
  return migrated;
}

let transactionsList = migrateTransactions(loadFromStorage(STORAGE_KEYS.tx, []));
let favoritesList = loadFromStorage(STORAGE_KEYS.fav, []);
mergeDuplicateFavorites();
let appSettings = loadFromStorage(STORAGE_KEYS.settings, { notifications: true, darkMode: false });
// الرمز السري الفعلي يُحمَّل لاحقاً بشكل غير متزامن عبر loadSavedPinsSecurely()
// (تخزين مشفّر بنسخة أندرويد الأصلية)؛ هذه القيمة الابتدائية فقط لمنع أخطاء undefined.
let savedPins = { jawwal: '', palpay: '' };
let appLockState = loadFromStorage(STORAGE_KEYS.applock, { enabled: false, hash: '', salt: '' });

// ---------- تخزين مشفّر للرموز السرية المحفوظة (بدل localStorage نص صريح) ----------
// السبب: كانت الرموز السرية لخدمتي جوال باي/بال باي تُحفظ نصاً صريحاً غير مشفّر
// بـlocalStorage، وهو ملف عادي داخل تخزين التطبيق يمكن الوصول له عبر نسخ احتياطي
// (adb backup) أو صلاحية root. الآن تُشفَّر عبر مفتاح في Android Keystore (لا
// يُصدَّر أبداً) من خلال SecurePrefsPlugin. على نسخة الويب/PWA (بلا Capacitor
// أصلي) نستمر باستخدام localStorage كاحتياط وحيد الخيار المتاح هناك.
function isSecurePrefsAvailable() {
  return !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform() &&
    Capacitor.Plugins && Capacitor.Plugins.SecurePrefs);
}

async function loadSavedPinsSecurely() {
  if (isSecurePrefsAvailable()) {
    try {
      const { value } = await Capacitor.Plugins.SecurePrefs.get({ key: STORAGE_KEYS.pins });
      if (value) {
        savedPins = JSON.parse(value);
        return;
      }
      // ترحيل لمرة واحدة: نسخة قديمة غير مشفّرة محفوظة من قبل هذا الإصلاح؟
      const legacy = loadFromStorage(STORAGE_KEYS.pins, null);
      if (legacy) {
        savedPins = legacy;
        await Capacitor.Plugins.SecurePrefs.set({ key: STORAGE_KEYS.pins, value: JSON.stringify(legacy) });
        try { localStorage.removeItem(STORAGE_KEYS.pins); } catch (e) { /* تجاهل */ }
        return;
      }
      savedPins = { jawwal: '', palpay: '' };
      return;
    } catch (e) {
      console.warn('SwiftPay: تعذرت قراءة الرموز السرية المشفّرة، سيتم استخدام تخزين محلي عادي', e);
    }
  }
  savedPins = loadFromStorage(STORAGE_KEYS.pins, { jawwal: '', palpay: '' });
}

async function saveSavedPinsSecurely(pins) {
  if (isSecurePrefsAvailable()) {
    try {
      await Capacitor.Plugins.SecurePrefs.set({ key: STORAGE_KEYS.pins, value: JSON.stringify(pins) });
      try { localStorage.removeItem(STORAGE_KEYS.pins); } catch (e) { /* تجاهل */ }
      return;
    } catch (e) {
      console.warn('SwiftPay: تعذر الحفظ المشفّر، تم الحفظ محلياً كاحتياط غير مشفّر', e);
    }
  }
  saveToStorage(STORAGE_KEYS.pins, pins);
}

// ---------- التاريخ والوقت الذكي (يُحسب لحظة العرض من timestamp حقيقي) ----------
const ARABIC_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

function formatArabicTime(d) {
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const period = h >= 12 ? 'م' : 'ص';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m} ${period}`;
}

function formatSmartDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = formatArabicTime(d);
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return `اليوم ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `أمس ${time}`;
  return `${d.getDate()} ${ARABIC_MONTHS[d.getMonth()]} ${d.getFullYear()} - ${time}`;
}

// ---------- تجزئة رمز القفل (لا يُحفظ كنص عادي أبداً) ----------
function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- SHA-256 بالجافاسكربت (احتياط عندما لا يتوفر crypto.subtle) ----------
// crypto.subtle يتطلب "سياق آمن" (HTTPS/localhost)؛ على بعض الأجهزة/الفتح عبر http://IP
// يكون غير موجود فيفشل التحقق من رمز القفل ويبقى المستخدم محجوباً. هذا الاحتياط
// يعطي نفس ناتج SHA-256 تماماً، فالتجزئات المحفوظة سابقاً تبقى صالحة.
const SHA256_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];
function sha256HexFallback(bytes) {
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes); padded[len] = 0x80;
  const bitLenHi = Math.floor(len / 0x20000000), bitLenLo = (len << 3) >>> 0;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLenHi); dv.setUint32(padded.length - 4, bitLenLo);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i-15], 7) ^ rotr(w[i-15], 18) ^ (w[i-15] >>> 3);
      const s1 = rotr(w[i-2], 17) ^ rotr(w[i-2], 19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return H.map(x => x.toString(16).padStart(8, '0')).join('');
}

function randomSaltHex() {
  const arr = new Uint8Array(16);
  if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(arr);
  else for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
  return bufferToHex(arr.buffer);
}

async function hashPin(pin, salt) {
  const enc = new TextEncoder().encode('swiftpay:' + salt + ':' + pin);
  if (window.crypto && crypto.subtle && crypto.subtle.digest) {
    try { return bufferToHex(await crypto.subtle.digest('SHA-256', enc)); } catch (e) { /* نسقط للاحتياط */ }
  }
  return sha256HexFallback(enc);
}

// ---------- بدء التطبيق: يُحجب خلف شاشة القفل إن كانت مفعّلة ----------
function initApp() {
  initPickerFields();
  renderHistory();
  renderFavorites();
  applySettingsUI();
  renderBalanceCard();
  renderHeaderSim(null);
  refreshHeaderSim();
  hideNativeSplashScreen();
  resumePendingPalpay();
  // تحديث الرصيد الحقيقي عند دخول الرئيسية (لا يمنع عرض الواجهة ولا يفشل بصمت)
  if (isNativeUssdAvailable() && JAWWAL_BALANCE_USSD_CODE) refreshJawwalBalance({ silent: true });
}

// نُخفي شاشة البداية الأصلية (شعار SwiftPay) بأنفسنا فور جهوزية أول شاشة فعلية،
// بدل الاعتماد فقط على launchShowDuration الثابتة في capacitor.config.json
function hideNativeSplashScreen() {
  try {
    if (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.SplashScreen) {
      Capacitor.Plugins.SplashScreen.hide();
    }
  } catch (e) { /* لا يوجد Capacitor (متصفح ويب عادي) — لا حاجة لفعل شيء */ }
}

window.addEventListener('load', async () => {
  // قراءة الرموز المشفّرة لا يجوز أن تعطّل الإقلاع: مهلة 2.5 ثانية ثم نكمل بالقيم الافتراضية
  try {
    await Promise.race([loadSavedPinsSecurely(), new Promise(resolve => setTimeout(resolve, 2500))]);
  } catch (e) {
    console.warn('SwiftPay: تعذرت قراءة الرموز السرية عند الإقلاع', e);
  }

  try {
    if (appLockState && appLockState.enabled && appLockState.hash) {
      document.getElementById('applock-screen').classList.add('visible');
    } else {
      initApp();
    }
  } finally {
    // مهما حدث: نُخفي شاشة البداية الأصلية ونعلن اكتمال الإقلاع لحارس الشاشة البيضاء
    hideNativeSplashScreen();
    window.__swiftpayBooted = true;
  }

  // تسجيل service worker لضمان العمل دون إنترنت بعد أول فتح
  // ملاحظة: الملف بجذر المشروع (وليس داخل /pwa/) كي يشمل نطاق تحكمه (scope)
  // كامل التطبيق تلقائياً دون الاعتماد على أي هيدر خاص من الاستضافة
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').then(reg => {
      console.log('SwiftPay: service worker مسجّل بنجاح، النطاق:', reg.scope);
    }).catch(err => {
      console.error('SwiftPay: فشل تسجيل service worker', err);
    });
  } else {
    console.warn('SwiftPay: هذا المتصفح لا يدعم Service Worker، لن يعمل التطبيق بدون إنترنت.');
  }
});

function applySettingsUI() {
  renderSimSettingsRow();
  const notifToggle = document.getElementById('notif-toggle');
  const darkToggle = document.getElementById('dark-toggle');
  if (notifToggle) notifToggle.checked = appSettings.notifications;
  if (darkToggle) darkToggle.checked = appSettings.darkMode === true;
  const themeDesc = document.getElementById('theme-desc');
  if (themeDesc) themeDesc.innerText = appSettings.darkMode === true ? 'الوضع الداكن' : 'الوضع الفاتح';
  updatePinStatusText();
  updateApplockUI();
}

// ================= قفل التطبيق برمز سري (PIN Lock) =================
let applockModalMode = 'enable'; // 'enable' | 'change' | 'disable'
let applockBuffer = '';

function updateApplockUI() {
  const toggle = document.getElementById('applock-toggle');
  const changeRow = document.getElementById('applock-change-row');
  const statusText = document.getElementById('applock-status-text');
  if (toggle) toggle.checked = !!appLockState.enabled;
  if (changeRow) changeRow.style.display = appLockState.enabled ? 'flex' : 'none';
  if (statusText) statusText.innerText = appLockState.enabled
    ? 'مفعّل — سيُطلب الرمز عند كل فتح للتطبيق'
    : 'حماية إضافية بشاشة قفل عند فتح التطبيق';
  updatePinStatusText();
}

function onApplockToggle(checked) {
  if (checked && !appLockState.enabled) {
    openApplockSetup('enable');
  } else if (!checked && appLockState.enabled) {
    openApplockSetup('disable');
  }
}

function openChangeApplockPin() {
  openApplockSetup('change');
}

function openApplockSetup(mode) {
  applockModalMode = mode;
  document.getElementById('applock-old-input').value = '';
  document.getElementById('applock-new-input').value = '';
  document.getElementById('applock-confirm-input').value = '';
  document.getElementById('applock-setup-error').style.display = 'none';

  const oldGroup = document.getElementById('applock-old-group');
  const newGroup = document.getElementById('applock-new-group');
  const confirmGroup = document.getElementById('applock-confirm-group');
  const title = document.getElementById('applock-setup-title');
  const desc = document.getElementById('applock-setup-desc');
  const confirmBtn = document.getElementById('applock-setup-confirm-btn');

  if (mode === 'enable') {
    oldGroup.style.display = 'none';
    newGroup.style.display = 'block';
    confirmGroup.style.display = 'block';
    title.innerText = 'تفعيل قفل التطبيق';
    desc.innerText = 'أنشئ رمزاً من 4 أرقام لحماية التطبيق عند فتحه';
    confirmBtn.innerText = 'تفعيل';
  } else if (mode === 'change') {
    oldGroup.style.display = 'block';
    newGroup.style.display = 'block';
    confirmGroup.style.display = 'block';
    title.innerText = 'تغيير رمز القفل';
    desc.innerText = 'أدخل رمزك الحالي، ثم الرمز الجديد';
    confirmBtn.innerText = 'حفظ التغيير';
  } else {
    oldGroup.style.display = 'block';
    newGroup.style.display = 'none';
    confirmGroup.style.display = 'none';
    title.innerText = 'تعطيل قفل التطبيق';
    desc.innerText = 'أدخل الرمز الحالي لتأكيد التعطيل';
    confirmBtn.innerText = 'تعطيل القفل';
  }

  document.getElementById('applock-setup-backdrop').style.display = 'flex';
}

function closeApplockSetup() {
  document.getElementById('applock-setup-backdrop').style.display = 'none';
  updateApplockUI();
}

function showApplockSetupError(msg) {
  const el = document.getElementById('applock-setup-error');
  el.innerText = msg;
  el.style.display = 'block';
}

async function submitApplockSetup() {
  const oldPin = document.getElementById('applock-old-input').value.trim();
  const newPin = document.getElementById('applock-new-input').value.trim();
  const confirmPin = document.getElementById('applock-confirm-input').value.trim();

  if (applockModalMode !== 'enable') {
    if (!/^\d{4}$/.test(oldPin)) { showApplockSetupError('أدخل الرمز الحالي المكوّن من 4 أرقام'); return; }
    const oldHash = await hashPin(oldPin, appLockState.salt);
    if (oldHash !== appLockState.hash) { showApplockSetupError('الرمز الحالي غير صحيح'); return; }
  }

  if (applockModalMode === 'disable') {
    appLockState = { enabled: false, hash: '', salt: '' };
    saveToStorage(STORAGE_KEYS.applock, appLockState);
    hidePinModal();
    closeApplockSetup();
    return;
  }

  if (!/^\d{4}$/.test(newPin)) { showApplockSetupError('الرمز الجديد يجب أن يكون 4 أرقام بالضبط'); return; }
  if (newPin !== confirmPin) { showApplockSetupError('الرمزان غير متطابقين'); return; }

  const salt = randomSaltHex();
  const hash = await hashPin(newPin, salt);
  appLockState = { enabled: true, hash, salt };
  saveToStorage(STORAGE_KEYS.applock, appLockState);
  closeApplockSetup();
}

// ---------- شاشة القفل عند بدء التطبيق ----------
function updateApplockDots() {
  const dots = document.querySelectorAll('#applock-dots span');
  dots.forEach((dot, i) => dot.classList.toggle('filled', i < applockBuffer.length));
}

function applockPressDigit(digit) {
  if (applockBuffer.length >= 4) return;
  applockBuffer += digit;
  updateApplockDots();
  if (applockBuffer.length === 4) {
    setTimeout(verifyApplockAttempt, 120);
  }
}

function applockBackspace() {
  applockBuffer = applockBuffer.slice(0, -1);
  updateApplockDots();
  document.getElementById('applock-subtitle').classList.remove('error');
  document.getElementById('applock-subtitle').innerText = 'لحماية بياناتك المالية';
}

async function verifyApplockAttempt() {
  const attemptHash = await hashPin(applockBuffer, appLockState.salt);
  if (attemptHash === appLockState.hash) {
    unlockApp();
  } else {
    const dotsWrap = document.getElementById('applock-dots');
    const subtitle = document.getElementById('applock-subtitle');
    dotsWrap.classList.add('shake');
    subtitle.classList.add('error');
    subtitle.innerText = 'رمز غير صحيح، حاول مرة أخرى';
    setTimeout(() => {
      dotsWrap.classList.remove('shake');
      applockBuffer = '';
      updateApplockDots();
    }, 380);
  }
}

function unlockApp() {
  const screen = document.getElementById('applock-screen');
  screen.classList.add('leaving');
  setTimeout(() => {
    screen.classList.remove('visible', 'leaving');
    applockBuffer = '';
    updateApplockDots();
    document.getElementById('applock-subtitle').classList.remove('error');
    document.getElementById('applock-subtitle').innerText = 'لحماية بياناتك المالية';
    initApp();
  }, 260);
}

function updatePinStatusText() {
  const el = document.getElementById('pin-status-text');
  if (!el) return;
  const row = document.getElementById('pins-row');
  const locked = !(appLockState && appLockState.enabled);
  if (row) { row.classList.toggle('is-disabled', locked); row.setAttribute('aria-disabled', locked ? 'true' : 'false'); }
  if (locked) { el.innerText = 'يتطلب تفعيل قفل التطبيق أولاً'; return; }
  const count = (savedPins.jawwal ? 1 : 0) + (savedPins.palpay ? 1 : 0);
  el.innerText = count === 0 ? 'اضغط لحفظ رمز كل خدمة مسبقاً' : `محفوظ لـ ${count} من أصل 2 خدمة`;
}

function showPinModal() {
  // الوصول للرموز السرية مشروط فعلياً (وليس بالواجهة فقط) بتفعيل قفل التطبيق
  if (!appLockState || !appLockState.enabled) {
    alert('فعّل قفل التطبيق أولاً للوصول إلى الرموز السرية');
    return;
  }
  document.getElementById('pin-jawwal-input').value = savedPins.jawwal || '';
  document.getElementById('pin-palpay-input').value = savedPins.palpay || '';
  document.getElementById('pin-modal-backdrop').style.display = 'flex';
}

function hidePinModal() {
  document.getElementById('pin-modal-backdrop').style.display = 'none';
}

async function savePinCodes() {
  if (!appLockState || !appLockState.enabled) { hidePinModal(); return; }
  const jawwalPin = document.getElementById('pin-jawwal-input').value.trim();
  const palpayPin = document.getElementById('pin-palpay-input').value.trim();

  if (jawwalPin && !/^\d{4}$/.test(jawwalPin)) {
    alert('رمز جوال باي يجب أن يكون 4 أرقام بالضبط');
    return;
  }
  if (palpayPin && !/^\d{4}$/.test(palpayPin)) {
    alert('رمز بال باي يجب أن يكون 4 أرقام بالضبط');
    return;
  }

  savedPins = { jawwal: jawwalPin, palpay: palpayPin };
  await saveSavedPinsSecurely(savedPins);
  updatePinStatusText();
  hidePinModal();
}

function setDarkMode(checked) {
  appSettings.darkMode = checked;
  saveToStorage(STORAGE_KEYS.settings, appSettings);
  if (typeof swiftpaySetTheme === 'function') swiftpaySetTheme(checked);
  applySettingsUI();
}

function toggleSetting(key, checked) {
  appSettings[key] = checked;
  saveToStorage(STORAGE_KEYS.settings, appSettings);
}

function handleBack() {
  if (transferBusy) return; // لا رجوع أثناء تنفيذ التحويل
  // صفحات «حول» (الخصوصية/الدعم) ترجع إلى الإعدادات لا إلى الرئيسية
  const cur = document.querySelector('.view.active-view');
  if (cur && (cur.id === 'privacy-view' || cur.id === 'support-view')) { switchTab('settings'); return; }
  resetToHome();
}

function startWizard(service) {
  if (transferBusy) return;
  if (hasPendingPalpay()) { showPendingConfirm(); return; }
  selectedContact = null;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active-view'));
  document.getElementById('wizard-view').classList.add('active-view');
  document.getElementById('backBtn').style.visibility = 'visible';
  setPageTitle(service === 'jawwal' ? 'تحويل جوال باي' : 'تحويل بال باي');
  selectService(service);
  // رصيد حديث = مقارنة أدق للمبلغ (تحديث صامت، لا يمنع استخدام الشاشة)
  if (service === 'jawwal' && isNativeUssdAvailable() && JAWWAL_BALANCE_USSD_CODE &&
      recentBalanceNumber(60000) === null) {
    refreshJawwalBalance({ silent: true });
  }
}

function selectService(service) {
  currentService = service;
  applyServiceTheme(document.getElementById('wizard-view'), service);
  const banner = document.getElementById('selected-service-banner');
  const nameEl = document.getElementById('banner-service-name');
  const iconEl = document.getElementById('banner-service-icon');

  if (service === 'jawwal') {
    nameEl.innerText = 'الخدمة المختارة: جوال باي';
    iconEl.innerHTML = svcGlyph('jawwal');
    banner.className = 'selected-service-banner jawwal-banner';
  } else {
    nameEl.innerText = 'الخدمة المختارة: بال باي';
    iconEl.innerHTML = svcGlyph('palpay');
    banner.className = 'selected-service-banner palpay-banner';
  }
  banner.style.display = 'flex';
  document.getElementById('wizard-step-2').style.display = 'block';
  updateTypeToggleUI();
  validateAmountAgainstBalance();
}

// النوع (صديق/تاجر) صار مجرد تبديل داخل نفس شاشة البيانات، بدون الانتقال
// لخطوة منفصلة — هذا هو جوهر تقليص المعالج من 4 خطوات إلى خطوتين.
function selectTransferType(type) {
  currentType = type;
  updateTypeToggleUI();
}

function updateTypeToggleUI() {
  const serviceName = currentService === 'jawwal' ? 'جوال باي' : 'بال باي';
  const typeName = currentType === 'friend' ? 'صديق' : 'تاجر';
  document.getElementById('form-title').innerText = `تحويل ${serviceName} - ${typeName}`;

  const pinGroup = document.getElementById('pin-group');
  const pinInput = document.getElementById('input-pin');
  pinGroup.style.display = currentService === 'palpay' ? 'none' : 'block';
  pinInput.value = savedPins[currentService] || '';

  const friendBtn = document.getElementById('type-btn-friend');
  const merchantBtn = document.getElementById('type-btn-merchant');
  if (friendBtn && merchantBtn) {
    friendBtn.classList.toggle('active', currentType === 'friend');
    merchantBtn.classList.toggle('active', currentType === 'merchant');
  }
}

let transferBusy = false;      // عملية تحويل جارية (تأكيد/تنفيذ/تحقق) — تمنع أي عملية ثانية
let pendingTransfer = null;    // بيانات التحويل بانتظار تأكيد المستخدم
let selectedContact = null;    // { name, phone } لجهة اتصال اختارها المستخدم

const DIAL_GUARD_MS = 40000;   // سقف زمني في الواجهة حتى لو لم يردّ الـplugin
const BALANCE_WAIT_MS = 5000;  // انتظار قصير بعد التحويل قبل قراءة الرصيد
const BALANCE_RETRY_GAP_MS = 1500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise(r => setTimeout(() => r({ timedOut: true }), ms))]);
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setSubmitLocked(locked) {
  const btn = document.getElementById('submit-transfer-btn');
  if (!btn) return;
  btn.disabled = locked;
  btn.style.pointerEvents = locked ? 'none' : '';
  btn.style.opacity = locked ? '0.6' : '';
}

// أيقونة الخدمة (SVG من sprite في index.html)
function svcGlyph(service) {
  return '<svg class="icon svc-glyph"><use href="#i-svc-wallet"></use></svg>';
}

// الخدمة: جوال باي أو بال باي. النوع: صديق / تاجر، وللتسجيل الخارجي فقط: E-Sadad / E-Buraq
const SERVICE_META = {
  jawwal: { label: 'جوال باي', letter: svcGlyph('jawwal') },
  palpay: { label: 'بال باي', letter: svcGlyph('palpay') },
  bankpal: { label: 'بنك فلسطين', letter: svcGlyph('bankpal') }
};
function svcMeta(service) { return SERVICE_META[service] || SERVICE_META.palpay; }
// بنك فلسطين: تسجيل في السجل فقط (لا آلية USSD له بالتطبيق) فلا إعادة حركة له
function isExternalOnlyTx(tx) { return isExternalOnlyType(tx.type) || tx.service === 'bankpal'; }
function serviceLabel(service) { return svcMeta(service).label; }
const TYPE_LABELS = { friend: 'صديق', merchant: 'تاجر', sadad: 'E-Sadad', buraq: 'E-Buraq' };
function typeLabel(type) { return TYPE_LABELS[type] || 'تاجر'; }
// أنواع لا يمكن تنفيذها من التطبيق (تسجيل خارجي فقط): لا إعادة حركة لها
function isExternalOnlyType(type) { return type === 'sadad' || type === 'buraq'; }
// عنوان بطاقة العملية: "الخدمة - الاسم أو النوع"
function txTitle(tx) {
  return svcMeta(tx.service).label + ' - ' + escapeHtml(tx.name || typeLabel(tx.type));
}

// اسم المستفيد: من جهة الاتصال المختارة (إن طابق رقمها)، أو من المفضلة، وإلا فارغ
function resolveBeneficiaryName(phone) {
  if (selectedContact && selectedContact.name && selectedContact.phone === phone) return selectedContact.name;
  const fav = favoritesList.find(f => f.phone === phone);
  return fav && fav.name ? fav.name : '';
}

function buildUssdCode(service, type, phone, amount, pin) {
  if (service === 'jawwal') {
    return type === 'friend' ? `*110*1*${pin}*${phone}*${amount}*1#` : `*110*2*${pin}*${phone}*${amount}*1#`;
  }
  return type === 'friend' ? `*370*1*1*${phone}*${amount}#` : `*370*2*${phone}*${amount}#`;
}

// ---------- مقارنة المبلغ بالرصيد (جوال باي فقط؛ له مصدر رصيد فعلي) ----------
// تعيد نص الخطأ إن كان المبلغ أكبر من آخر رصيد معروف، وإلا نصاً فارغاً.
function insufficientBalanceMessage(amountStr) {
  if (currentService !== 'jawwal') return '';
  if (balanceState.amount === null) return '';
  const bal = parseFloat(balanceState.amount);
  const amt = parseFloat(String(amountStr).replace(',', '.'));
  if (isNaN(bal) || isNaN(amt) || amt <= 0) return '';
  if (amt <= bal + 0.005) return '';
  return balanceState.hidden ? 'الرصيد غير كافٍ' : `الرصيد غير كافٍ — رصيدك الحالي ${formatMoney(bal)} ₪`;
}

// يُستدعى مع كل كتابة بحقل المبلغ، وعند تغيّر الرصيد أو الخدمة
function validateAmountAgainstBalance() {
  const amountEl = document.getElementById('input-amount');
  if (!amountEl) return;
  clearFieldError(amountEl);
  const msg = insufficientBalanceMessage(amountEl.value.trim());
  if (msg) showFieldError(amountEl, msg);
}

// الخطوة 1: تحقق من الحقول ثم اعرض حوار التأكيد (لا تنفيذ مباشر)
function submitTransfer() {
  if (transferBusy) return;
  if (hasPendingPalpay()) { showPendingConfirm(); return; }

  const phoneEl = document.getElementById('input-phone');
  const amountEl = document.getElementById('input-amount');
  const pinEl = document.getElementById('input-pin');

  const phone = phoneEl.value.trim();
  const amount = amountEl.value.trim().replace(',', '.');
  const pin = pinEl.value.trim();
  const pinRequired = document.getElementById('pin-group').style.display !== 'none';

  clearFieldError(phoneEl);
  clearFieldError(amountEl);
  clearFieldError(pinEl);

  let firstInvalid = null;

  if (!/^0\d{8,9}$/.test(phone)) {
    showFieldError(phoneEl, 'أدخل رقم هاتف صحيح (مثال: 0591234567)');
    firstInvalid = firstInvalid || phoneEl;
  }
  if (amount === '' || isNaN(amount) || Number(amount) <= 0) {
    showFieldError(amountEl, 'أدخل مبلغاً صحيحاً أكبر من صفر');
    firstInvalid = firstInvalid || amountEl;
  } else {
    const lowMsg = insufficientBalanceMessage(amount);
    if (lowMsg) {
      showFieldError(amountEl, lowMsg);
      firstInvalid = firstInvalid || amountEl;
    }
  }
  if (pinRequired && !/^\d{4}$/.test(pin)) {
    showFieldError(pinEl, 'أدخل رمزاً سرياً مكوناً من 4 أرقام');
    firstInvalid = firstInvalid || pinEl;
  }

  if (firstInvalid) {
    firstInvalid.focus();
    return;
  }

  pendingTransfer = {
    service: currentService,
    type: currentType,
    phone: phone,
    amount: amount,
    name: resolveBeneficiaryName(phone),
    code: buildUssdCode(currentService, currentType, phone, amount, pin)
  };
  openConfirmTransfer(pendingTransfer);
}

function detailsRowsHtml(t) {
  const rows = [];
  if (t.name) rows.push(['المستفيد', escapeHtml(t.name)]);
  rows.push(['الرقم', escapeHtml(t.phone)]);
  rows.push(['المبلغ', escapeHtml(t.amount) + ' شيكل']);
  rows.push(['نوع التحويل', serviceLabel(t.service) + ' - ' + typeLabel(t.type)]);
  return rows.map(r => `<div class="confirm-row"><span>${r[0]}</span><span>${r[1]}</span></div>`).join('');
}

function openConfirmTransfer(t) {
  document.getElementById('confirm-transfer-text').innerText =
    `هل أنت متأكد من تحويل ${t.amount} شيكل إلى الرقم ${t.phone}؟`;
  document.getElementById('confirm-transfer-details').innerHTML = detailsRowsHtml(t);
  document.getElementById('confirm-transfer-ok').disabled = false;
  document.getElementById('confirm-transfer-backdrop').style.display = 'flex';
}

function closeConfirmTransfer() {
  document.getElementById('confirm-transfer-backdrop').style.display = 'none';
  pendingTransfer = null; // إلغاء: لا يُنفَّذ شيء
}

// الخطوة 2: تأكيد المستخدم
async function confirmTransfer() {
  if (transferBusy || !pendingTransfer) return;
  // داخل التطبيق الأصلي: لا نبدأ أي عملية قبل التأكد أن الشريحة المختارة متاحة وجاهزة.
  if (isNativeUssdAvailable()) {
    transferBusy = true; // يمنع الضغط المزدوج أثناء الفحص
    let ready = true;
    try { ready = await ensureSimReady(); } catch (e) { ready = true; /* البوابة الأصلية تفحص أيضاً */ }
    transferBusy = false;
    if (!ready || !pendingTransfer) return; // ظهر اختيار الشريحة؛ يضغط المستخدم تأكيد مرة أخرى بعد الاختيار
  }
  confirmTransferProceed();
}

function confirmTransferProceed() {
  if (transferBusy || !pendingTransfer) return;
  if (hasPendingPalpay()) { closeConfirmTransfer(); showPendingConfirm(); return; }
  const t = pendingTransfer;
  pendingTransfer = null;
  transferBusy = true;
  setSubmitLocked(true);
  document.getElementById('confirm-transfer-ok').disabled = true;
  document.getElementById('confirm-transfer-backdrop').style.display = 'none';

  // التحقق الحقيقي بالرصيد متاح فقط لجوال باي داخل التطبيق الأصلي (له مصدر رصيد فعلي).
  // بال باي (جلسة USSD تفاعلية بلا رد برمجي) ونسخة الويب/PWA لا يمكن التحقق منهما،
  // فيبقيان على السلوك السابق: تنفيذ ثم تسجيل ثم رجوع للرئيسية.
  const canVerify = t.service === 'jawwal' && isNativeUssdAvailable() && !!JAWWAL_BALANCE_USSD_CODE;
  if (canVerify) {
    runVerifiedTransfer(t);
  } else if (t.service === 'palpay') {
    // بال باي: لا نسجّل الحوالة قبل أن يؤكد المستخدم نجاحها. نحفظها كعملية معلّقة
    // (قبل إطلاق جلسة USSD، كي تبقى حتى لو أُغلق التطبيق) ثم نسأله بعد ~30 ثانية.
    savePendingPalpay({
      id: (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2))),
      service: t.service, type: t.type, phone: t.phone, amount: t.amount,
      name: t.name || '', code: t.code, startedAt: Date.now()
    });
    callCode(t.code);
    transferBusy = false;
    setSubmitLocked(false);
    resetToHome();
    schedulePendingPrompt();
  } else {
    addTransactionRecord(t);
    callCode(t.code);
    transferBusy = false;
    setSubmitLocked(false);
    resetToHome();
  }
}

// كود USSD الفعلي (جوال باي) يحمل الرمز السري ضمن نصه؛ نخفيه دائماً قبل التخزين
function addTransactionRecord(t, opts) {
  const PIN_MASK = '****';
  const codeForStorage = t.service === 'jawwal'
    ? (t.type === 'friend'
        ? `*110*1*${PIN_MASK}*${t.phone}*${t.amount}*1#`
        : `*110*2*${PIN_MASK}*${t.phone}*${t.amount}*1#`)
    : t.code;
  const txId = (opts && opts.id) || (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2)));
  const rec = {
    id: txId,
    service: t.service,
    type: t.type,
    phone: t.phone,
    amount: t.amount,
    timestamp: (opts && opts.timestamp) || Date.now(),
    code: codeForStorage
  };
  if (t.name) rec.name = t.name;
  transactionsList.unshift(rec);
  saveToStorage(STORAGE_KEYS.tx, transactionsList);
  renderHistory();
}

// ---------- شاشة "جاري تنفيذ التحويل" والنتيجة ----------
function execDetailsHtml(t) {
  const svc = t.service === 'jawwal' ? 'jawwal' : 'palpay';
  const letter = svc === 'jawwal' ? 'J' : 'P';
  const rows = [];
  if (t.name) rows.push(`<div class="exec-row"><span class="exec-row-ico"><svg class="icon"><use href="#i-user"></use></svg></span><span class="exec-row-label">المستفيد</span><span class="exec-row-val">${escapeHtml(t.name)}</span></div>`);
  rows.push(`<div class="exec-row"><span class="exec-row-ico"><svg class="icon"><use href="#i-phone-call"></use></svg></span><span class="exec-row-label">الرقم</span><span class="exec-row-val exec-ltr">${escapeHtml(t.phone)}</span></div>`);
  rows.push(`<div class="exec-row"><span class="exec-row-ico exec-row-letter">${letter}</span><span class="exec-row-label">نوع التحويل</span><span class="exec-row-val">${serviceLabel(t.service)} - ${typeLabel(t.type)}</span></div>`);
  return `
    <div class="exec-amount">
      <small>المبلغ</small>
      <b><span>${escapeHtml(t.amount)}</span><i>₪</i></b>
    </div>
    <div class="exec-rows">${rows.join('')}</div>`;
}

function showExecScreen(t) {
  const card = document.getElementById('exec-card');
  applyServiceTheme(card, t.service === 'jawwal' ? 'jawwal' : 'palpay');
  card.dataset.state = 'pending';
  const icon = document.getElementById('exec-icon');
  icon.className = 'result-icon pending';
  icon.innerHTML = '<svg class="icon"><use href="#i-refresh"></use></svg>';
  document.getElementById('exec-title').innerText = 'جاري تنفيذ التحويل';
  document.getElementById('exec-sub').innerText = 'الرجاء الانتظار وعدم إغلاق التطبيق';
  document.getElementById('exec-details').innerHTML = execDetailsHtml(t);
  document.getElementById('exec-done-btn').style.display = 'none';
  document.getElementById('exec-screen').style.display = 'flex';
}

function finishExecScreen(ok, title, sub) {
  const icon = document.getElementById('exec-icon');
  document.getElementById('exec-card').dataset.state = ok ? 'success' : 'failed';
  icon.className = 'result-icon ' + (ok ? 'success' : 'failed');
  icon.innerHTML = `<svg class="icon"><use href="#${ok ? 'i-check' : 'i-x'}"></use></svg>`;
  document.getElementById('exec-title').innerText = title;
  document.getElementById('exec-sub').innerText = sub || '';
  document.getElementById('exec-done-btn').style.display = 'block';
  document.getElementById('exec-done-btn').dataset.ok = ok ? '1' : '0';
  transferBusy = false;
  setSubmitLocked(false);
}

function closeExecScreen() {
  const ok = document.getElementById('exec-done-btn').dataset.ok === '1';
  document.getElementById('exec-screen').style.display = 'none';
  if (ok) {
    document.getElementById('input-phone').value = '';
    document.getElementById('input-amount').value = '';
    clearFieldError(document.getElementById('input-amount'));
    selectedContact = null;
  }
  resetToHome();
}

// ---------- تنفيذ التحويل مع التحقق الحقيقي بالرصيد ----------
async function runVerifiedTransfer(t) {
  showExecScreen(t);
  const amount = Number(t.amount);
  const fail = (title, sub) => finishExecScreen(false, title, sub);

  try {
    // لا نخلط جلستي USSD: انتظر أي تحديث رصيد جارٍ أولاً
    if (balanceRefreshPromise) { try { await balanceRefreshPromise; } catch (e) { /* تجاهل */ } }

    // الرصيد السابق: آخر قراءة حقيقية حديثة (دقيقتان)، وإلا نقرأه الآن قبل الإرسال
    let before = recentBalanceNumber(120000);
    if (before === null) {
      const r = await fetchJawwalBalanceValue();
      if (r.value === null) {
        if (r.reason === 'sim') return fail('الشريحة غير جاهزة', simErrorMessage(r.simError) + ' لم يتم تنفيذ أي تحويل.');
        return fail('تعذر قراءة الرصيد', 'لم يتم تنفيذ أي تحويل. حاول مرة أخرى.');
      }
      storeBalanceReading(r);
      before = r.value;
    }

    const dial = await withTimeout(Capacitor.Plugins.UssdDialer.dial(withSim({ code: t.code })), DIAL_GUARD_MS);
    if (dial && dial.simError) {
      return fail('الشريحة غير جاهزة', simErrorMessage(dial.simError) + ' لم يتم تنفيذ أي تحويل.');
    }
    if (!(dial && dial.supported && dial.permissionGranted) && !(dial && dial.timedOut)) {
      return fail('تعذر تنفيذ التحويل', 'لم يُرسَل الطلب. تأكد من منح صلاحية الاتصال ثم حاول مرة أخرى.');
    }

    await sleep(BALANCE_WAIT_MS);

    // Refresh #1، وإن فشل Refresh #2 فقط — لا حلقات ولا انتظار مفتوح
    let reading = await fetchJawwalBalanceValue();
    if (reading.value === null) {
      await sleep(BALANCE_RETRY_GAP_MS);
      reading = await fetchJawwalBalanceValue();
    }
    if (reading.value === null) {
      return fail('تعذر تحديث الرصيد', 'انتظر دقيقة ثم تحقق من الرصيد.');
    }

    // الرصيد الجديد يأتي من المصدر الحقيقي (لا خصم محلي أبداً)
    storeBalanceReading(reading);

    if (before - reading.value >= amount - 0.005) {
      addTransactionRecord(t);
      finishExecScreen(true, 'تم التحويل بنجاح', `${t.amount} شيكل إلى ${t.name || t.phone}`);
    } else {
      fail('فشل التحقق من التحويل', 'انتظر دقيقة ثم تحقق من الرصيد أو سجل العمليات.');
    }
  } catch (e) {
    console.error('SwiftPay: خطأ أثناء تنفيذ التحويل', e);
    fail('فشل التحويل', 'انتظر دقيقة ثم تحقق من الرصيد أو سجل العمليات.');
  }
}

// ---------- اختيار المستفيد من جهات الاتصال ----------
function normalizePalestinePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  // مقدّمة الدولة: +970 أو +972 (أو 00970 / 00972) تُستبدل بصفر واحد
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length > 10 && (d.startsWith('970') || d.startsWith('972'))) d = d.slice(3);
  // إزالة أي أصفار زائدة (مثل 972-0599...) ثم إضافة صفر واحد فقط
  d = d.replace(/^0+/, '');
  return d ? '0' + d : '';
}

function applyPickedContact(name, rawPhone) {
  const phoneEl = document.getElementById('input-phone');
  const phone = normalizePalestinePhone(rawPhone);
  clearFieldError(phoneEl);
  if (!/^0\d{8,9}$/.test(phone)) {
    showFieldError(phoneEl, 'رقم جهة الاتصال المختارة غير صالح');
    return;
  }
  phoneEl.value = phone;
  selectedContact = { name: (name || '').trim(), phone: phone };
}

async function pickContact() {
  const phoneEl = document.getElementById('input-phone');
  try {
    if (window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform() &&
        Capacitor.Plugins && Capacitor.Plugins.ContactPicker) {
      const r = await Capacitor.Plugins.ContactPicker.pick();
      if (r && !r.cancelled && r.phone) applyPickedContact(r.name, r.phone);
    } else if (navigator.contacts && navigator.contacts.select) {
      const res = await navigator.contacts.select(['name', 'tel'], { multiple: false });
      if (res && res.length && res[0].tel && res[0].tel[0]) {
        applyPickedContact(res[0].name && res[0].name[0], res[0].tel[0]);
      }
    } else {
      showFieldError(phoneEl, 'اختيار جهة الاتصال غير متاح على هذا الجهاز');
    }
  } catch (e) {
    showFieldError(phoneEl, 'تعذر فتح جهات الاتصال');
  }
}

function showFieldError(inputEl, message) {
  inputEl.closest('.input-wrapper').classList.add('input-wrapper-error');
  let err = inputEl.closest('.input-group').querySelector('.field-error');
  if (!err) {
    err = document.createElement('div');
    err.className = 'field-error';
    inputEl.closest('.input-group').appendChild(err);
  }
  err.innerText = message;
}

function clearFieldError(inputEl) {
  inputEl.closest('.input-wrapper').classList.remove('input-wrapper-error');
  const err = inputEl.closest('.input-group').querySelector('.field-error');
  if (err) err.remove();
}

function copyTextRobust(text) {
  return new Promise((resolve) => {
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => resolve(true),
        () => resolve(legacyCopy(text))
      );
    } else {
      resolve(legacyCopy(text));
    }
  });
}

function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.left = '-1000px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

let transferCalling = false;

async function callCode(code) {
  if (transferCalling) return;
  transferCalling = true;

  // Stage 2: إذا التطبيق يشتغل native جوا Capacitor وplugin الـUSSD موجود،
  // نجرب الاتصال المباشر (بدون فتح شاشة الداير) ونقرأ رد الشبكة الحقيقي.
  // أي حالة غير مؤكدة (منصة ويب عادية، صلاحية مرفوضة، Android قديم، أو خطأ)
  // بترجع بنفس أسلوب tel: الأصلي بالأسفل بدون أي تغيير.
  // بال باي تحتاج جلستين تفاعليتين حقيقيتين (رمز سري ثم تأكيد بالاسم) — sendUssdRequest
  // عاجزة عن هذا بنيوياً (طلب واحد/رد واحد فقط)، فنتخطاها لهذه الخدمة تحديداً
  // ونروح مباشرة لأسلوب tel: (ديالوج النظام يتعامل مع الجلسات المتعددة طبيعياً).
  const skipSilentUssd = currentService === 'palpay';

  // بال باي: بدل أسلوب tel: بالأسفل (الذي يُترجَم من أندرويد كـACTION_DIAL
  // فيفتح تطبيق الهاتف بالكامل ويطلب ضغط زر الاتصال يدوياً)، نستخدم هنا
  // ACTION_CALL عبر الـplugin (نفس صلاحية CALL_PHONE الممنوحة أعلاه بالفعل).
  // أندرويد يتعرف تلقائياً على كود USSD ويعرض حواره الخاص بالجلسة فوق
  // SwiftPay مباشرة بدل تحويل المستخدم فعلياً لتطبيق الهاتف. لا رد برمجي
  // متاحاً هنا (أندرويد لا يعيد نتيجة USSD التفاعلية لأي تطبيق)، وهذا متوقع:
  // لا ننتظر أي نتيجة أصلاً، فقط نطلق الجلسة ونعتبر التنفيذ منتهياً من طرفنا.
  if (skipSilentUssd && window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform() &&
      Capacitor.Plugins && Capacitor.Plugins.UssdDialer && Capacitor.Plugins.UssdDialer.dialInteractive) {
    try {
      const result = await Capacitor.Plugins.UssdDialer.dialInteractive(withSim({ code }));
      if (result && result.simError) {
        // الشريحة غير جاهزة: لا ننفّذ على شريحة أخرى ولا نسقط لأسلوب tel:
        transferCalling = false;
        openSimPicker(simErrorMessage(result.simError));
        return;
      }
      if (result && result.supported && result.permissionGranted && result.dialed) {
        transferCalling = false;
        return;
      }
      // صلاحية مرفوضة أو استجابة غير متوقعة — نسقط بأمان لأسلوب tel: بالأسفل
      // بدل ترك المستخدم بلا أي وسيلة لإتمام التحويل.
    } catch (e) {
      // نفس منطق السقوط الآمن أعلاه عند أي استثناء غير متوقع.
    }
  }

  if (!skipSilentUssd && window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform() &&
      Capacitor.Plugins && Capacitor.Plugins.UssdDialer) {
    try {
      const result = await Capacitor.Plugins.UssdDialer.dial(withSim({ code }));
      if (result && result.simError) {
        transferCalling = false;
        openSimPicker(simErrorMessage(result.simError));
        return;
      }
      if (result && result.supported && result.permissionGranted) {
        // أي رد فعلي من الشبكة (نص، فشل صريح، أو حتى مهلة انتهت) يعني أن
        // sendUssdRequest نُفّذ فعلياً على الشبكة. لا نحلّل الرد ولا نعرضه —
        // فقط لا نسقط لأسلوب tel: بالأسفل، لأن ذلك سيعيد الاتصال بنفس الكود
        // وينفّذ التحويل مرتين فعلياً على الشبكة (هذا أمان تنفيذ، وليس تحققاً
        // من النتيجة).
        if (typeof result.response === 'string' || typeof result.failureCode === 'number' ||
            result.error || result.timedOut) {
          transferCalling = false;
          return;
        }
      }
    } catch (e) {
      // نكمل بالأسلوب الأصلي بالأسفل — هنا فقط، لأن الاستثناء يعني أن sendUssdRequest
      // لم يُنفَّذ فعلياً بعد (فشل مبكر)، فلا خطر تكرار تنفيذ نفس التحويل.
    }
  }

  // داخل التطبيق الأصلي وبشريحة مختارة: أسلوب tel: يستخدم شريحة الاتصال الافتراضية للنظام
  // وقد تكون غير المختارة، فلا نسقط إليه أبداً (لا تنفيذ على شريحة أخرى تلقائياً).
  if (isNativeUssdAvailable() && simSelection) {
    transferCalling = false;
    openSimPicker('تعذّر تنفيذ الطلب عبر الشريحة المختارة. تأكد من صلاحية الاتصال ثم أعد المحاولة.');
    return;
  }

  // ===== الأسلوب الأصلي (PWA / fallback) — بدون أي تغيير =====
  // ملاحظة: لا يجب ترميز * عبر encodeURIComponent، وبعض متصفحات الأندرويد
  // لا تتعرف على كود USSD إذا كان مُرمّزاً بالكامل. لكن # يُقتطع من رابط
  // tel: باعتباره بداية "fragment"، لذلك نرمّزه فقط كـ %23 هنا.
  const dialHref = code.replace(/#/g, '%23');
  const link = document.createElement('a');
  link.href = 'tel:' + dialHref;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  transferCalling = false;
}

// ================= إدارة شرائح SIM =================
// المبدأ: لا نفترض أن الشريحة الأولى هي الصحيحة ولا ننفّذ على شريحة أخرى بصمت.
// المستخدم يختار الشريحة التي تحمل خدمة جوال باي (الرصيد والتحويل)، ويُحفظ اختياره محلياً،
// ويتحقق الجزء الأصلي (UssdPlugin) من وجودها قبل كل عملية، وإلا يُرجع simError ولا ينفّذ شيئاً.
const SIM_STORAGE_KEY = 'swiftpay_sim';
let simSelection = (function () {
  const v = loadFromStorage(SIM_STORAGE_KEY, null);
  return v && typeof v.subscriptionId === 'number' ? v : null;
})();
let simListCache = [];
let simDefaultVoiceId = -1;

function simArgs() {
  return simSelection ? { subscriptionId: simSelection.subscriptionId, slotIndex: simSelection.slotIndex } : {};
}
function withSim(obj) { return Object.assign({}, obj, simArgs()); }

function simErrorMessage(code) {
  switch (code) {
    case 'no_sim': return 'لا توجد شريحة SIM فعّالة في الجهاز.';
    case 'needs_selection': return 'يوجد أكثر من شريحة. اختر الشريحة التي تحتوي خدمة الرصيد والتحويل.';
    case 'sim_unavailable': return 'الشريحة المختارة غير متاحة (ربما أُخرجت). اختر الشريحة من جديد.';
    case 'sim_changed': return 'تغيّرت الشريحة الموجودة في هذا المكان. اختر الشريحة من جديد.';
    case 'sim_bind_failed': return 'تعذّر التأكد أن الاتصال سيتم عبر الشريحة المختارة. اجعلها شريحة الاتصال الافتراضية في إعدادات الجهاز ثم أعد المحاولة.';
    case 'permission': return 'لازم توافق على صلاحية الهاتف لعرض الشرائح.';
    default: return 'تعذّر تحديد الشريحة.';
  }
}

// قراءة الشرائح الفعّالة. passive=true: لا تطلب الصلاحية (للعرض الصامت فقط).
async function fetchSims(passive) {
  if (!isNativeUssdAvailable()) return null;
  try {
    const plugin = Capacitor.Plugins.UssdDialer;
    if (passive && plugin.checkPermissions) {
      const p = await plugin.checkPermissions();
      if (!p || p.phonePerms !== 'granted') return null;
    }
    const r = await withTimeout(plugin.getSims(), 60000);
    if (!r || r.timedOut) return null;
    if (r.permissionGranted === false) return { permissionGranted: false, sims: [] };
    simListCache = Array.isArray(r.sims) ? r.sims : [];
    simDefaultVoiceId = typeof r.defaultVoiceSubId === 'number' ? r.defaultVoiceSubId : -1;
    const res = { permissionGranted: true, sims: simListCache };
    renderHeaderSim(res); // أي قراءة ناجحة للشرائح تحدّث الهيدر
    return res;
  } catch (e) {
    return null;
  }
}

// اسم الشريحة في الهيدر: اسم المشغّل فقط. نضيف رقم الخانة فقط إذا تطابق اسما شريحتين.
function simDisplayName(s, all) {
  const base = simCarrierLabel(s) || simSlotLabel(s);
  const dup = (all || []).some(x => x.subscriptionId !== s.subscriptionId && simCarrierLabel(x) === simCarrierLabel(s));
  return dup ? base + ' · ' + simSlotLabel(s) : base;
}

function renderHeaderSim(r) {
  const el = document.getElementById('hdr-sim');
  const txt = document.getElementById('hdr-sim-text');
  if (!el || !txt) return;
  if (!isNativeUssdAvailable()) { el.className = 'hdr-sim'; return; }
  let label = '';
  let warn = false;
  const sims = r && r.permissionGranted ? r.sims : null;
  if (sims) {
    const problem = simSelectionProblem(sims);
    if (problem === 'no_sim') { label = 'لا توجد شريحة'; warn = true; }
    else if (problem) { label = 'اختر الشريحة'; warn = true; }
    else {
      const cur = simSelection ? sims.find(x => x.subscriptionId === simSelection.subscriptionId) : sims[0];
      label = simDisplayName(cur, sims);
    }
  } else if (simSelection) {
    label = simDisplayName(simSelection, simListCache);
  } else {
    el.className = 'hdr-sim';
    return;
  }
  txt.textContent = label;
  el.className = 'hdr-sim has-sim' + (warn ? ' warn' : '');
}

function refreshHeaderSim() { return fetchSims(true); } // صامت: لا يطلب صلاحية

function simSlotLabel(s) { return 'SIM ' + (Number(s.slotIndex) + 1); }
function simCarrierLabel(s) { return String((s && (s.carrierName || s.displayName)) || '').trim(); }

// null = الشريحة المختارة سليمة، وإلا رمز المشكلة (نفس رموز simError الأصلية)
function simSelectionProblem(sims) {
  if (!sims.length) return 'no_sim';
  if (!simSelection) return sims.length === 1 ? null : 'needs_selection';
  const m = sims.find(x => x.subscriptionId === simSelection.subscriptionId);
  if (!m) return 'sim_unavailable';
  if (m.slotIndex !== simSelection.slotIndex) return 'sim_changed';
  return null;
}

async function ensureSimReady() {
  const r = await fetchSims(false);
  if (!r) return true; // تعذّر الفحص هنا؛ البوابة الأصلية تتحقق أيضاً قبل أي تنفيذ
  if (!r.permissionGranted) { openSimPicker(simErrorMessage('permission'), r); return false; }
  const problem = simSelectionProblem(r.sims);
  if (!problem) return true;
  openSimPicker(simErrorMessage(problem), r);
  return false;
}

function renderSimSettingsRow(problem) {
  const el = document.getElementById('sim-settings-desc');
  if (!el) return;
  if (problem) {
    el.innerText = simErrorMessage(problem);
    el.classList.add('sim-warn');
    return;
  }
  el.classList.remove('sim-warn');
  if (!isNativeUssdAvailable()) { el.innerText = 'متاح فقط بنسخة تطبيق أندرويد'; return; }
  el.innerText = simSelection
    ? simSlotLabel(simSelection) + (simCarrierLabel(simSelection) ? ' · ' + simCarrierLabel(simSelection) : '')
    : 'لم تُحدَّد بعد — اضغط للاختيار';
}

async function refreshSimSettingsRow() {
  renderSimSettingsRow();
  const r = await fetchSims(true);
  if (r && r.permissionGranted) {
    const problem = simSelectionProblem(r.sims);
    // لا نزعج بحالة "تحتاج اختياراً" هنا؛ النص الافتراضي يوضّح ذلك
    renderSimSettingsRow(problem === 'needs_selection' ? null : problem);
  }
}

async function openSimPicker(message, preloaded) {
  const backdrop = document.getElementById('sim-picker-backdrop');
  if (!backdrop) return;
  const msgEl = document.getElementById('sim-picker-msg');
  if (msgEl) {
    msgEl.innerText = message || '';
    msgEl.style.display = message ? 'block' : 'none';
  }
  const box = document.getElementById('sim-list');
  box.innerHTML = '<div class="sim-empty">جاري البحث عن الشرائح...</div>';
  backdrop.style.display = 'flex';
  const r = preloaded || await fetchSims(false);
  renderSimList(r);
}

function renderSimList(r) {
  const box = document.getElementById('sim-list');
  if (!box) return;
  if (!isNativeUssdAvailable()) { box.innerHTML = '<div class="sim-empty">اختيار الشريحة متاح فقط بنسخة تطبيق أندرويد.</div>'; return; }
  if (!r) { box.innerHTML = '<div class="sim-empty">تعذّرت قراءة الشرائح. حاول مرة أخرى.</div>'; return; }
  if (!r.permissionGranted) { box.innerHTML = '<div class="sim-empty">' + escapeHtml(simErrorMessage('permission')) + '</div>'; return; }
  if (!r.sims.length) { box.innerHTML = '<div class="sim-empty">' + escapeHtml(simErrorMessage('no_sim')) + '</div>'; return; }
  box.innerHTML = r.sims.map((s, i) => {
    const selected = !!simSelection && simSelection.subscriptionId === s.subscriptionId && simSelection.slotIndex === s.slotIndex;
    const carrier = simCarrierLabel(s);
    const subParts = [];
    if (s.number) subParts.push(escapeHtml(s.number));
    if (s.displayName && s.displayName !== s.carrierName) subParts.push(escapeHtml(s.displayName));
    if (s.subscriptionId === simDefaultVoiceId) subParts.push('شريحة الاتصال الافتراضية');
    return '<button type="button" class="sim-option' + (selected ? ' selected' : '') + '" onclick="chooseSim(' + i + ')">' +
      '<span class="sim-option-main"><b>' + escapeHtml(simSlotLabel(s)) + '</b>' +
      (carrier ? '<span>' + escapeHtml(carrier) + '</span>' : '') + '</span>' +
      (subParts.length ? '<small>' + subParts.join(' · ') + '</small>' : '') +
      (selected ? '<span class="sim-option-check"><svg class="icon"><use href="#i-check"></use></svg></span>' : '') +
      '</button>';
  }).join('');
}

function chooseSim(i) {
  const s = simListCache[i];
  if (!s) return;
  simSelection = {
    subscriptionId: Number(s.subscriptionId),
    slotIndex: Number(s.slotIndex),
    carrierName: String(s.carrierName || ''),
    displayName: String(s.displayName || '')
  };
  saveToStorage(SIM_STORAGE_KEY, simSelection);
  renderSimSettingsRow();
  renderHeaderSim({ permissionGranted: true, sims: simListCache });
  closeSimPicker();
  // الرصيد القديم قد يعود لشريحة أخرى: نحدّثه من الشريحة الجديدة (تحديث صامت)
  if (isNativeUssdAvailable() && JAWWAL_BALANCE_USSD_CODE) refreshJawwalBalance({ silent: true });
}

async function refreshSimPicker() {
  const box = document.getElementById('sim-list');
  if (box) box.innerHTML = '<div class="sim-empty">جاري البحث عن الشرائح...</div>';
  renderSimList(await fetchSims(false));
}

// الشريحة قد تتغير أو تُخرَج والتطبيق بالخلفية: نحدّث الهيدر عند العودة للتطبيق
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') refreshHeaderSim();
});

function closeSimPicker() {
  const b = document.getElementById('sim-picker-backdrop');
  if (b) b.style.display = 'none';
}

// ===== Stage 3: بطاقة رصيد جوال باي =====
//
// كود فحص رصيد جوال باي عبر USSD (تم تأكيده يدويًا من الهاتف): *110*3#
const JAWWAL_BALANCE_USSD_CODE = '*110*3#';

const BALANCE_STORAGE_KEY = 'swiftpay_balance_jawwal';
let balanceState = loadFromStorage(BALANCE_STORAGE_KEY, { amount: null, updatedAt: null, hidden: false });

function renderBalanceCard() {
  const valueEl = document.getElementById('balance-amount-value');
  const metaEl = document.getElementById('balance-card-meta');
  const eyeUse = document.getElementById('balance-eye-icon');
  if (!valueEl || !metaEl || !eyeUse) return; // الكرت لسا ما انضاف بالـHTML

  if (balanceState.amount === null) {
    valueEl.innerText = '--';
  } else {
    valueEl.innerText = balanceState.hidden ? '••••' : balanceState.amount;
  }

  eyeUse.querySelector('use').setAttribute('href', balanceState.hidden ? '#i-eye-off' : '#i-eye');

  if (!metaEl.classList.contains('error')) {
    metaEl.innerText = balanceState.updatedAt
      ? 'آخر تحديث: ' + formatArabicTime(new Date(balanceState.updatedAt))
      : 'لم يتم التحديث بعد — دوس تحديث';
  }
}

function toggleBalanceVisibility() {
  balanceState.hidden = !balanceState.hidden;
  saveToStorage(BALANCE_STORAGE_KEY, balanceState);
  renderBalanceCard();
}

function isNativeUssdAvailable() {
  return !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform() &&
    Capacitor.Plugins && Capacitor.Plugins.UssdDialer);
}

// لا نخمّن صيغة الرد، بس نطلع أول رقم عشري موجود بالنص (الصيغة الشائعة
// لردود USSD اللي بتذكر الرصيد بالنص)
function extractBalanceFromResponse(text) {
  const match = (text || '').match(/(\d+(?:[.,]\d+)?)/);
  return match ? match[1].replace(',', '.') : null;
}

function setBalanceMeta(message, isError) {
  const metaEl = document.getElementById('balance-card-meta');
  if (!metaEl) return;
  metaEl.innerText = message;
  metaEl.classList.toggle('error', !!isError);
}

// قراءة الرصيد الحقيقي من الشبكة دون أي تعديل على الواجهة أو الحالة.
// تعيد { value: number|null, text, reason }.
async function fetchJawwalBalanceValue() {
  if (!JAWWAL_BALANCE_USSD_CODE || !isNativeUssdAvailable()) return { value: null, reason: 'unavailable' };
  try {
    const result = await withTimeout(
      Capacitor.Plugins.UssdDialer.dial(withSim({ code: JAWWAL_BALANCE_USSD_CODE })), DIAL_GUARD_MS);
    if (result && result.simError) return { value: null, reason: 'sim', simError: result.simError };
    if (result && result.supported && result.permissionGranted && typeof result.response === 'string') {
      const text = extractBalanceFromResponse(result.response);
      if (text !== null) return { value: parseFloat(text), text: text, reason: 'ok' };
      return { value: null, reason: 'parse' };
    }
    if (result && result.timedOut) return { value: null, reason: 'timeout' };
    if (result && !result.permissionGranted) return { value: null, reason: 'permission' };
    return { value: null, reason: 'failed' };
  } catch (e) {
    return { value: null, reason: 'error' };
  }
}

function storeBalanceReading(reading) {
  balanceState.amount = reading.text;
  balanceState.updatedAt = Date.now();
  saveToStorage(BALANCE_STORAGE_KEY, balanceState);
  setBalanceMeta('', false);
  renderBalanceCard();
  validateAmountAgainstBalance();
}

// آخر قراءة حقيقية إن كانت أحدث من maxAgeMs، وإلا null
function recentBalanceNumber(maxAgeMs) {
  if (balanceState.amount === null || !balanceState.updatedAt) return null;
  if (Date.now() - balanceState.updatedAt > maxAgeMs) return null;
  const n = parseFloat(balanceState.amount);
  return isNaN(n) ? null : n;
}

let balanceRefreshPromise = null;

function refreshJawwalBalance(opts) {
  if (balanceRefreshPromise) return balanceRefreshPromise;
  const done = () => { balanceRefreshPromise = null; };
  balanceRefreshPromise = doRefreshJawwalBalance(opts && opts.silent === true).then(done, done);
  return balanceRefreshPromise;
}

async function doRefreshJawwalBalance(silent) {
  const btn = document.getElementById('balance-refresh-btn');
  const card = document.getElementById('jawwal-balance-card');

  if (!JAWWAL_BALANCE_USSD_CODE) {
    setBalanceMeta('كود فحص الرصيد غير مُعدّ بعد بالتطبيق', true);
    return;
  }
  if (!isNativeUssdAvailable()) {
    setBalanceMeta('التحديث التلقائي متاح فقط بنسخة تطبيق أندرويد المثبتة', true);
    return;
  }

  if (btn) btn.classList.add('spinning');
  if (card) card.classList.add('refreshing'); // القيمة القديمة لا تظهر كأنها محدّثة
  setBalanceMeta('جاري التحديث...', false);

  try {
    const r = await fetchJawwalBalanceValue();
    if (r.value !== null) {
      storeBalanceReading(r);
    } else if (r.reason === 'parse') {
      setBalanceMeta('تعذّر قراءة الرصيد من رد الشبكة', true);
    } else if (r.reason === 'timeout') {
      setBalanceMeta('لم يصل رد من الشبكة خلال الوقت المتوقع، حاول لاحقاً', true);
    } else if (r.reason === 'sim') {
      // لا نعرض أي رصيد من شريحة غير مؤكدة. التحديث الصامت (عند الفتح) يكتفي برسالة،
      // وضغط المستخدم على زر التحديث يفتح اختيار الشريحة مباشرة.
      setBalanceMeta(simErrorMessage(r.simError), true);
      if (!silent) openSimPicker(simErrorMessage(r.simError));
    } else if (r.reason === 'permission') {
      setBalanceMeta('لازم توافق على صلاحية الاتصال لعرض الرصيد', true);
    } else {
      setBalanceMeta('تعذّر تنفيذ الطلب، حاول مرة أخرى', true);
    }
  } finally {
    if (btn) btn.classList.remove('spinning');
    if (card) card.classList.remove('refreshing');
    renderBalanceCard();
    refreshHeaderSim(); // قد تكون الصلاحية مُنحت الآن
  }
}

function resetToHome() {
  switchTab('home');
}

// ================= حول: الخصوصية والدعم =================
// وسائل التواصل: أي حقل يُترك فارغاً يُخفى صفّه من صفحة الدعم.
//   whatsapp: الرقم بصيغة دولية بدون + أو أصفار (مثال: 970591234567)
//   email:    بريد الدعم        page: رابط الصفحة (يبدأ بـ https://)
const SUPPORT_CONTACTS = { whatsapp: '970594089552', email: 'nadidstudio@gmail.com', page: '' };
const SUPPORT_MESSAGE = 'مرحباً، أحتاج مساعدة بخصوص تطبيق SwiftPay';

function renderSupportContacts() {
  const box = document.getElementById('support-contacts');
  if (!box) return;
  const rows = [];
  const row = (href, icon, cls, title, sub) =>
    `<a class="settings-item-row support-row" href="${href}" target="_blank" rel="noopener">
       <div class="settings-item-left">
         <div class="settings-item-icon ${cls}"><svg class="icon"><use href="#${icon}"></use></svg></div>
         <div class="settings-item-text"><h4>${title}</h4><p>${sub}</p></div>
       </div>
       <svg class="icon" style="color:var(--text-muted);"><use href="#i-arrow-right"></use></svg>
     </a>`;
  const wa = String(SUPPORT_CONTACTS.whatsapp || '').replace(/\D/g, '');
  if (wa) rows.push(row('https://wa.me/' + wa + '?text=' + encodeURIComponent(SUPPORT_MESSAGE), 'i-whatsapp', 'icon-green', 'واتساب', 'راسلنا مباشرة على واتساب'));
  const em = String(SUPPORT_CONTACTS.email || '').trim();
  if (em) rows.push(row('mailto:' + em + '?subject=' + encodeURIComponent('دعم SwiftPay'), 'i-mail', 'icon-red', 'البريد الإلكتروني', escapeHtml(em)));
  const pg = String(SUPPORT_CONTACTS.page || '').trim();
  if (pg) rows.push(row(escapeHtml(pg), 'i-globe', 'icon-purple', 'صفحتنا', 'تعرّف على أعمالنا وتطبيقاتنا'));
  box.innerHTML = rows.length ? rows.join('') :
    '<div class="support-empty">سيتم إضافة وسائل التواصل قريباً.</div>';
}

// فتح صفحة معلومات (privacy | support) مع إبقاء تبويب الإعدادات مفعّلاً
function openInfoPage(name) {
  if (transferBusy) return;
  const id = name === 'support' ? 'support-view' : 'privacy-view';
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active-view'));
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  document.getElementById(id).classList.add('active-view');
  document.querySelector('.nav-item:nth-child(4)').classList.add('active');
  setPageTitle(name === 'support' ? 'الدعم' : 'سياسة الخصوصية');
  document.getElementById('backBtn').style.visibility = 'visible';
  const fab = document.getElementById('fab-external');
  if (fab) fab.style.display = 'none';
  const main = document.querySelector('main'); if (main) main.scrollTop = 0;
  window.scrollTo(0, 0);
  if (id === 'support-view') renderSupportContacts();
}

// ================= منتقي التاريخ والوقت (بدل منتقي النظام) =================
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const AR_DAYS_FULL = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const AR_DOW_SAT_FIRST = ['س', 'ح', 'ن', 'ث', 'ر', 'خ', 'ج'];
let pickerState = null;

// "2026-11-01" أو "2026-11-01T22:27" -> مكوّنات
function parsePickerValue(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(String(v || ''));
  if (!m) return null;
  return { y: +m[1], mo: +m[2] - 1, d: +m[3], h: m[4] != null ? +m[4] : 0, mi: m[5] != null ? +m[5] : 0 };
}
function fmtTime12(h, mi) {
  const ap = h >= 12 ? 'م' : 'ص';
  return (h % 12 || 12) + ':' + pad2(mi) + ' ' + ap;
}
function refreshPickerField(btn) {
  const inp = document.getElementById(btn.dataset.pickerFor);
  const p = parsePickerValue(inp.value);
  const isDT = btn.dataset.kind === 'datetime';
  let txt = '';
  if (p) txt = p.d + ' ' + AR_MONTHS[p.mo] + ' ' + p.y + (isDT ? ' • ' + fmtTime12(p.h, p.mi) : '');
  btn.innerHTML = '<svg class="icon"><use href="#i-calendar"></use></svg><span>' + (txt || 'اختر التاريخ') + '</span>';
  btn.classList.toggle('is-empty', !txt);
}
function initPickerFields() {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  document.querySelectorAll('.picker-field').forEach(btn => {
    const inp = document.getElementById(btn.dataset.pickerFor);
    // أي تعيين برمجي للقيمة (inp.value = ...) يحدّث النص الظاهر تلقائياً
    Object.defineProperty(inp, 'value', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); refreshPickerField(btn); }
    });
    btn.addEventListener('click', () => openPicker(inp.id));
    refreshPickerField(btn);
  });
  // عجلة الساعة والدقيقة: سحب لأعلى/أسفل لتغيير القيمة، ولمسة على الرقم لكتابته
  document.querySelectorAll('.picker-wheel').forEach(initPickerWheel);
  const dow = document.getElementById('picker-dow');
  if (dow) dow.innerHTML = AR_DOW_SAT_FIRST.map(d => '<span>' + d + '</span>').join('');
}


// سحب عمودي = تغيير القيمة (كل ~26px خطوة)، لمسة بلا سحب = تعديل الرقم يدوياً (أو خطوة عند لمس الرقم المجاور)
function initPickerWheel(wheel) {
  const kind = wheel.dataset.wheel;               // h | m
  const input = wheel.querySelector('.pw-cur');
  const STEP_PX = 26;
  let startY = 0, applied = 0, moved = false, active = false, startTarget = null;
  wheel.addEventListener('pointerdown', (e) => {
    if (!pickerState || !input.readOnly) return;  // أثناء الكتابة نترك الإدخال طبيعياً
    active = true; moved = false; startY = e.clientY; applied = 0; startTarget = e.target;
    try { wheel.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  wheel.addEventListener('pointermove', (e) => {
    if (!active || !pickerState) return;
    const total = Math.round((startY - e.clientY) / STEP_PX);   // لأعلى = قيمة أكبر
    if (Math.abs(startY - e.clientY) > 6) moved = true;
    if (total !== applied) { pickerStep(kind, total - applied); applied = total; }
  });
  const end = () => {
    if (!active) return;
    active = false;
    if (!moved && pickerState) {
      if (startTarget && startTarget.classList.contains('pw-prev')) pickerStep(kind, -1);
      else if (startTarget && startTarget.classList.contains('pw-next')) pickerStep(kind, 1);
      else beginWheelEdit(kind, input);
    }
  };
  wheel.addEventListener('pointerup', end);
  wheel.addEventListener('pointercancel', () => { active = false; });
  wheel.addEventListener('wheel', (e) => {            // عجلة الفأرة (حاسوب)
    if (!pickerState) return;
    e.preventDefault();
    pickerStep(kind, e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });
  input.addEventListener('blur', () => commitWheelEdit(kind, input));
}
function beginWheelEdit(kind, input) {
  input.readOnly = false;
  input.focus();
  input.select();
}
function commitWheelEdit(kind, input) {
  if (input.readOnly) return;
  input.readOnly = true;
  const s = pickerState;
  const raw = input.value.replace(/\D/g, '');
  if (s && raw !== '') {
    const v = parseInt(raw, 10);
    if (kind === 'm') { if (v >= 0 && v <= 59) s.mi = v; }
    else if (v >= 13 && v <= 23) s.h = v;                       // كتابة بنظام 24 ساعة
    else if (v === 0) s.h = 0;
    else if (v >= 1 && v <= 12) s.h = (v % 12) + (s.h >= 12 ? 12 : 0);
  }
  renderPicker();
}

function openPicker(inputId) {
  const inp = document.getElementById(inputId);
  const btn = document.querySelector('.picker-field[data-picker-for="' + inputId + '"]');
  const kind = btn.dataset.kind;
  const cur = parsePickerValue(inp.value);
  const now = new Date();
  const base = cur || { y: now.getFullYear(), mo: now.getMonth(), d: now.getDate(), h: now.getHours(), mi: now.getMinutes() };
  pickerState = {
    inputId, kind, max: parsePickerValue(inp.max),
    viewY: base.y, viewM: base.mo, y: base.y, mo: base.mo, d: base.d, h: base.h, mi: base.mi
  };
  document.getElementById('picker-time').style.display = kind === 'datetime' ? 'flex' : 'none';
  document.getElementById('picker-kicker').innerText = kind === 'datetime' ? 'اختر التاريخ والوقت' : 'اختر التاريخ';
  renderPicker();
  document.getElementById('picker-backdrop').style.display = 'flex';
}
function closePicker() {
  document.querySelectorAll('.pw-cur').forEach(i => { i.readOnly = true; });
  document.getElementById('picker-backdrop').style.display = 'none';
  pickerState = null;
}
function pickerBeyondMax(y, mo, d) {
  const m = pickerState.max;
  return !!m && (y > m.y || (y === m.y && (mo > m.mo || (mo === m.mo && d > m.d))));
}
function renderPicker() {
  const s = pickerState; if (!s) return;
  const dt = new Date(s.y, s.mo, s.d);
  document.getElementById('picker-title').innerText =
    AR_DAYS_FULL[dt.getDay()] + '، ' + s.d + ' ' + AR_MONTHS[s.mo] + ' ' + s.y +
    (s.kind === 'datetime' ? ' • ' + fmtTime12(s.h, s.mi) : '');
  document.getElementById('picker-month').innerText = AR_MONTHS[s.viewM] + ' ' + s.viewY;
  const first = new Date(s.viewY, s.viewM, 1);
  const lead = (first.getDay() + 1) % 7;               // السبت أول الأسبوع
  const days = new Date(s.viewY, s.viewM + 1, 0).getDate();
  const today = new Date();
  let html = '';
  for (let i = 0; i < lead; i++) html += '<span class="picker-empty"></span>';
  for (let d = 1; d <= days; d++) {
    const sel = (s.viewY === s.y && s.viewM === s.mo && d === s.d);
    const isToday = (s.viewY === today.getFullYear() && s.viewM === today.getMonth() && d === today.getDate());
    const dis = pickerBeyondMax(s.viewY, s.viewM, d);
    html += '<button type="button" class="picker-day' + (sel ? ' selected' : '') + (isToday ? ' today' : '') + '"' +
      (dis ? ' disabled' : '') + ' onclick="pickerPickDay(' + d + ')">' + d + '</button>';
  }
  document.getElementById('picker-grid').innerHTML = html;
  const h12 = s.h % 12 || 12;
  document.getElementById('picker-hour').value = h12;
  document.getElementById('picker-min').value = pad2(s.mi);
  document.getElementById('pw-h-prev').innerText = ((h12 + 10) % 12) + 1;
  document.getElementById('pw-h-next').innerText = (h12 % 12) + 1;
  document.getElementById('pw-m-prev').innerText = pad2((s.mi + 59) % 60);
  document.getElementById('pw-m-next').innerText = pad2((s.mi + 1) % 60);
  document.querySelectorAll('#picker-ampm button').forEach(b => b.classList.toggle('on', b.dataset.ap === (s.h >= 12 ? 'pm' : 'am')));
}
function pickerMonth(delta) {
  const s = pickerState; if (!s) return;
  const d = new Date(s.viewY, s.viewM + delta, 1);
  s.viewY = d.getFullYear(); s.viewM = d.getMonth();
  renderPicker();
}
function pickerPickDay(d) {
  const s = pickerState; if (!s) return;
  s.y = s.viewY; s.mo = s.viewM; s.d = d;
  renderPicker();
}
function pickerStep(kind, delta) {
  const s = pickerState; if (!s) return;
  if (kind === 'h') s.h = ((((s.h % 12) + delta) % 12) + 12) % 12 + (s.h >= 12 ? 12 : 0);   // الساعة تدور ضمن 12 دون تغيير ص/م
  else s.mi = (s.mi + delta + 60) % 60;
  renderPicker();
}
function pickerAmPm(ap) {
  const s = pickerState; if (!s) return;
  const pm = s.h >= 12;
  if (ap === 'pm' && !pm) s.h += 12;
  if (ap === 'am' && pm) s.h -= 12;
  renderPicker();
}
function pickerToday() {
  const s = pickerState; if (!s) return;
  const n = new Date();
  s.viewY = s.y = n.getFullYear(); s.viewM = s.mo = n.getMonth(); s.d = n.getDate();
  if (s.kind === 'datetime') { s.h = n.getHours(); s.mi = n.getMinutes(); }
  renderPicker();
}
function pickerConfirm() {
  const s = pickerState; if (!s) return;
  const inp = document.getElementById(s.inputId);
  let { y, mo, d, h, mi } = s;
  // لا نسمح بتجاوز الحد الأعلى (مثلاً: لا حوالات في المستقبل)
  if (s.max) {
    const sel = new Date(y, mo, d, s.kind === 'datetime' ? h : 0, s.kind === 'datetime' ? mi : 0).getTime();
    const mx = new Date(s.max.y, s.max.mo, s.max.d, s.kind === 'datetime' ? s.max.h : 0, s.kind === 'datetime' ? s.max.mi : 0).getTime();
    if (sel > mx) { y = s.max.y; mo = s.max.mo; d = s.max.d; h = s.max.h; mi = s.max.mi; }
  }
  const v = y + '-' + pad2(mo + 1) + '-' + pad2(d) + (s.kind === 'datetime' ? 'T' + pad2(h) + ':' + pad2(mi) : '');
  inp.value = v;
  closePicker();
  inp.dispatchEvent(new Event('change', { bubbles: true }));
}

function openNotifications() {
  if (transferBusy) return;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active-view'));
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  document.getElementById('notifications-view').classList.add('active-view');
  setPageTitle('الإشعارات');
  document.getElementById('backBtn').style.visibility = 'visible';
  const fab = document.getElementById('fab-external');
  if (fab) fab.style.display = 'none';
}

function switchTab(tabName) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active-view'));
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));

  const titles = { 'home': 'SwiftPay', 'history': 'سجل الحركات', 'favorites': 'المفضلة', 'settings': 'الإعدادات' };
  setPageTitle(titles[tabName] || 'SwiftPay');

  const indices = { 'home': 1, 'history': 2, 'favorites': 3, 'settings': 4 };
  document.getElementById(`${tabName}-view`).classList.add('active-view');
  document.querySelector(`.nav-item:nth-child(${indices[tabName]})`).classList.add('active');
  document.getElementById('backBtn').style.visibility = tabName === 'home' ? 'hidden' : 'visible';
  const fab = document.getElementById('fab-external');
  if (fab) fab.style.display = tabName === 'history' ? 'flex' : 'none';
  if (tabName === 'settings') refreshSimSettingsRow();
}

function txCardInner(tx) {
  const iconChar = svcMeta(tx.service).letter;
  return `
    <div class="tx-right">
      <div class="tx-icon ${tx.service}">${iconChar}</div>
      <div class="tx-details">
        <h4>${txTitle(tx)}</h4>
        ${tx.phone ? `<p>${escapeHtml(tx.phone)}</p>` : ''}
      </div>
    </div>
    <div class="tx-left">
      <div class="tx-amount">${tx.amount} شيكل</div>
      <div class="tx-time">${formatArabicTime(new Date(tx.timestamp))}</div>
    </div>
  `;
}

// بطاقة داخل صفحة السجل الكاملة: مجمّعة تحت عنوان يوم واحد، الوقت فقط بجانب كل عملية.
// سجل تنفيذ فقط — لا حالة نجاح/فشل/معالجة، والضغط عليها يفتح قائمة إجراءات
// (حذف/إعادة) دائماً.
function historyCard(tx) {
  return `<div class="transaction-card" onclick="openTxActions('${tx.id}')">${txCardInner(tx)}</div>`;
}

// بطاقة معاينة داخل الرئيسية (آخر 3 عمليات): تعرض التاريخ الذكي كاملاً كما كانت، بلا إجراءات إضافية
function homePreviewCard(tx) {
  const iconChar = svcMeta(tx.service).letter;
  return `
    <div class="transaction-card">
      <div class="tx-right">
        <div class="tx-icon ${tx.service}">${iconChar}</div>
        <div class="tx-details"><h4>${txTitle(tx)}</h4>${tx.phone ? `<p>${escapeHtml(tx.phone)}</p>` : ''}</div>
      </div>
      <div class="tx-left">
        <div class="tx-amount">${tx.amount} شيكل</div>
        <div class="tx-time">${formatSmartDate(tx.timestamp)}</div>
      </div>
    </div>
  `;
}

function dayGroupKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

function dayGroupLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'اليوم';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'أمس';
  return `${d.getDate()} ${ARABIC_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// ---------- سجل الحركات: تفضيلات العرض (إخفاء المبلغ، فترة البطاقة، فلتر الخدمة) ----------
const HISTORY_PREFS_KEY = 'swiftpay_history_prefs';
let historyPrefs = Object.assign({ hidden: false, period: 0, mode: 'month', from: '', to: '' }, loadFromStorage(HISTORY_PREFS_KEY, {}));
let historyFilter = 'all'; // 'all' | 'jawwal' | 'palpay' — يؤثر على القائمة فقط

function formatMoney(n) {
  return (Math.round(n * 100) / 100).toLocaleString('en-US');
}

// period: 0 = هذا الشهر، 1 = الشهر الماضي — تُحسب من timestamp حقيقي لكل عملية
function txInPeriod(tx, period) {
  const now = new Date();
  const ref = new Date(now.getFullYear(), now.getMonth() - period, 1);
  const d = new Date(tx.timestamp);
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
}

// ---------- الفترة المعروضة: شهر جاهز (mode='month') أو نطاق تواريخ مخصص (mode='range') ----------
function setPageTitle(text) {
  const el = document.getElementById('page-title');
  if (!el) return;
  el.innerText = text;
  el.classList.toggle('brand-text', text === 'SwiftPay');
  const hd = document.getElementById('app-header');
  if (hd) hd.classList.toggle('is-home', text === 'SwiftPay');
}
function pad2(n) { return String(n).padStart(2, '0'); }
function toDateInputValue(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function parseDateInput(v, endOfDay) {
  const parts = String(v || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return endOfDay ? new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999)
                  : new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
}
function formatDateAr(v) {
  const d = parseDateInput(v, false);
  return d ? d.getDate() + ' ' + ARABIC_MONTHS[d.getMonth()] + ' ' + d.getFullYear() : '';
}
function isRangeMode() { return historyPrefs.mode === 'range' && !!historyPrefs.from && !!historyPrefs.to; }
function txInView(tx) {
  if (isRangeMode()) {
    const f = parseDateInput(historyPrefs.from, false).getTime();
    const t = parseDateInput(historyPrefs.to, true).getTime();
    const ts = new Date(tx.timestamp).getTime();
    return ts >= f && ts <= t;
  }
  return txInPeriod(tx, historyPrefs.period);
}
function viewPeriodName() { return isRangeMode() ? 'نطاق مخصص' : periodName(historyPrefs.period); }
function viewPeriodText() {
  return isRangeMode()
    ? formatDateAr(historyPrefs.from) + ' - ' + formatDateAr(historyPrefs.to)
    : periodMonthText(historyPrefs.period);
}

function computeHistoryStats(period) {
  const st = { total: 0, jawwal: 0, palpay: 0, bankpal: 0, count: 0 };
  transactionsList.forEach(tx => {
    if (!txInView(tx)) return;
    const a = parseFloat(tx.amount);
    if (isNaN(a)) return;
    st.total += a;
    st.count++;
    if (tx.service === 'jawwal') st.jawwal += a; else if (tx.service === 'palpay') st.palpay += a; else if (tx.service === 'bankpal') st.bankpal += a;
  });
  return st;
}

function saveHistoryPrefs() { saveToStorage(HISTORY_PREFS_KEY, historyPrefs); }

// ---------- Service theme: مصدر واحد لألوان الخدمة ----------
// كل مفتاح يشير إلى متغيرات CSS الجاهزة (تتبدّل تلقائياً بين الليلي والنهاري).
// applyServiceTheme يضبط --svc* على العنصر، وكل الواجهة تقرأ منها فقط.
const SERVICE_THEMES = {
  all:    { accent: '--primary', bg: '--primary-bg', border: '--primary-border', grad: '--gradient-primary', shadow: '--primary-shadow', on: '--on-primary' },
  jawwal: { accent: '--jawwal',  bg: '--jawwal-bg',  border: '--jawwal-border',  grad: '--jawwal-grad',      shadow: '--jawwal-shadow',  on: '--on-jawwal' },
  palpay: { accent: '--palpay',  bg: '--palpay-bg',  border: '--palpay-border',  grad: '--palpay-grad',      shadow: '--palpay-shadow',  on: '--on-palpay' },
  bankpal: { accent: '--bankpal', bg: '--bankpal-bg', border: '--bankpal-border', grad: '--bankpal-grad',     shadow: '--bankpal-shadow', on: '--on-bankpal' }
};

function applyServiceTheme(el, key) {
  const t = SERVICE_THEMES[key] || SERVICE_THEMES.all;
  if (!el) return;
  el.dataset.service = key;
  el.style.setProperty('--svc', `var(${t.accent})`);
  el.style.setProperty('--svc-bg', `var(${t.bg})`);
  el.style.setProperty('--svc-border', `var(${t.border})`);
  el.style.setProperty('--svc-grad', `var(${t.grad})`);
  el.style.setProperty('--svc-shadow', `var(${t.shadow})`);
  el.style.setProperty('--svc-on', `var(${t.on})`);
}

const HISTORY_PERIODS = 13; // هذا الشهر ... قبل سنة

function periodName(p) {
  if (p === 0) return 'الشهر الحالي';
  if (p === 1) return 'الشهر السابق';
  if (p === 2) return 'قبل شهرين';
  if (p === 12) return 'قبل سنة';
  if (p <= 10) return 'قبل ' + p + ' أشهر';
  return 'قبل ' + p + ' شهراً';
}

function periodMonthText(p) {
  const ref = new Date(new Date().getFullYear(), new Date().getMonth() - p, 1);
  return ARABIC_MONTHS[ref.getMonth()] + ' ' + ref.getFullYear();
}

const METRIC_LABELS = { all: '', jawwal: 'جوال باي', palpay: 'بال باي', bankpal: 'بنك فلسطين' };

function renderHistorySummary() {
  const totalEl = document.getElementById('hist-total');
  if (!totalEl) return;
  const st = computeHistoryStats(historyPrefs.period);
  const hide = historyPrefs.hidden;
  const m = historyFilter;
  applyServiceTheme(document.getElementById('hist-summary'), m);
  const value = m === 'jawwal' ? st.jawwal : m === 'palpay' ? st.palpay : m === 'bankpal' ? st.bankpal : st.total;
  totalEl.innerText = hide ? '••••' : formatMoney(value);
  document.getElementById('hist-period-label').innerText =
    'تحويلات ' + (m === 'all' ? '' : METRIC_LABELS[m] + ' - ') + viewPeriodName();
  document.getElementById('hist-period-sub').innerText = viewPeriodText();
  document.getElementById('hist-eye-icon').querySelector('use').setAttribute('href', hide ? '#i-eye-off' : '#i-eye');
  document.getElementById('hist-options-count').innerText = viewPeriodText();
  const badge = document.getElementById('hist-options-badge');
  if (badge) badge.innerText = st.count + ' عملية';
  const cm = document.getElementById('hist-clear-month-sub');
  if (cm) cm.innerText = viewPeriodName() + ' (' + st.count + ' عملية)';

  const grid = document.getElementById('hist-month-grid');
  if (grid) {
    if (!grid.children.length) {
      let g = `<button type="button" class="hist-chip" data-p="custom" onclick="setHistoryCustomRange()"><span class="hist-chip-two">نطاق<br>مخصص</span></button>`;
      for (let p = 0; p < HISTORY_PERIODS; p++) {
        g += `<button type="button" class="hist-chip" data-p="${p}" onclick="setHistoryPeriod(${p})">${periodName(p)}<small>${periodMonthText(p)}</small></button>`;
      }
      grid.innerHTML = g;
    }
    grid.querySelectorAll('.hist-chip').forEach(b => {
      const on = historyPrefs.mode === 'range' ? b.dataset.p === 'custom' : Number(b.dataset.p) === historyPrefs.period && b.dataset.p !== 'custom';
      b.classList.toggle('active', on);
    });
  }
  const rangeCard = document.getElementById('hist-range-card');
  if (rangeCard) {
    rangeCard.style.display = historyPrefs.mode === 'range' ? 'block' : 'none';
    const fi = document.getElementById('hist-range-from');
    const ti = document.getElementById('hist-range-to');
    if (fi && fi.value !== historyPrefs.from) fi.value = historyPrefs.from;
    if (ti && ti.value !== historyPrefs.to) ti.value = historyPrefs.to;
  }
  document.querySelectorAll('#hist-filter .hist-filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.f === historyFilter);
  });
}

function toggleHistoryHidden() {
  historyPrefs.hidden = !historyPrefs.hidden;
  saveHistoryPrefs();
  renderHistorySummary();
}

function setHistoryPeriod(p) {
  historyPrefs.mode = 'month';
  historyPrefs.period = p;
  saveHistoryPrefs();
  renderHistorySummary();
}

// نطاق مخصص: أول مرة يبدأ من أول الشهر الحالي حتى اليوم
function setHistoryCustomRange() {
  historyPrefs.mode = 'range';
  if (!historyPrefs.from || !historyPrefs.to) {
    const now = new Date();
    historyPrefs.from = toDateInputValue(new Date(now.getFullYear(), now.getMonth(), 1));
    historyPrefs.to = toDateInputValue(now);
  }
  saveHistoryPrefs();
  renderHistorySummary();
}

function onHistoryRangeChange() {
  const from = document.getElementById('hist-range-from').value;
  const to = document.getElementById('hist-range-to').value;
  const err = document.getElementById('hist-range-error');
  if (from && to && from > to) {
    err.innerText = 'تاريخ البداية يجب أن يسبق تاريخ النهاية';
    err.style.display = 'block';
    return;
  }
  err.style.display = 'none';
  if (from) historyPrefs.from = from;
  if (to) historyPrefs.to = to;
  saveHistoryPrefs();
  renderHistorySummary();
}

// تبديل شاشة النافذة: الرئيسية أو مسح البيانات
function showHistoryOptView(view) {
  document.getElementById('hist-opt-main').style.display = view === 'main' ? 'block' : 'none';
  document.getElementById('hist-opt-delete').style.display = view === 'delete' ? 'block' : 'none';
}

function setHistoryFilter(f) {
  historyFilter = f;
  renderHistory();
  const act = document.querySelector('#hist-filter .hist-filter-btn[data-f="' + f + '"]');
  if (act && act.scrollIntoView) act.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

function openHistoryOptions() {
  showHistoryOptView('main');
  renderHistorySummary();
  document.getElementById('hist-options-backdrop').style.display = 'flex';
}

function closeHistoryOptions() {
  document.getElementById('hist-options-backdrop').style.display = 'none';
}

function renderHistory() {
  const fullContainer = document.getElementById('full-history-list');
  const homeContainer = document.getElementById('home-recent-list');

  renderHistorySummary();

  if (transactionsList.length === 0) {
    fullContainer.innerHTML = '<div class="empty-state">لا توجد عمليات مسجلة حتى الآن</div>';
    homeContainer.innerHTML = '<div class="empty-state" style="padding: 25px 10px;">السجل فارغ</div>';
    return;
  }

  const filtered = historyFilter === 'all'
    ? transactionsList
    : transactionsList.filter(tx => tx.service === historyFilter);

  // القائمة مرتّبة الأحدث أولاً أساساً (unshift عند كل عملية جديدة)، لذا التجميع
  // بمسح تسلسلي بسيط وفتح تجميعة جديدة كلما تغيّر مفتاح اليوم يعطي ترتيباً صحيحاً.
  let html = '';
  let lastKey = null;
  filtered.forEach(tx => {
    const key = dayGroupKey(tx.timestamp);
    if (key !== lastKey) {
      html += `<div class="history-day-header">${dayGroupLabel(tx.timestamp)}</div>`;
      lastKey = key;
    }
    html += historyCard(tx);
  });
  fullContainer.innerHTML = html || '<div class="empty-state">لا توجد عمليات لهذه الخدمة</div>';

  homeContainer.innerHTML = transactionsList.slice(0, 3).map(homePreviewCard).join('');
}

// ================= إجراءات العملية: حذف / إعادة =================
let txActionsTargetId = null;

const TYPE_FULL_LABELS = { friend: 'تحويل لصديق', merchant: 'تحويل لتاجر', sadad: 'E-Sadad', buraq: 'E-Buraq' };
function typeFullLabel(type) { return TYPE_FULL_LABELS[type] || 'تحويل لتاجر'; }

function receiptDateText(ts) {
  const d = new Date(ts);
  let h = d.getHours(); const pm = h >= 12; h = h % 12 || 12;
  return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + ' · ' + pad2(h) + ':' + pad2(d.getMinutes()) + (pm ? ' م' : ' ص');
}
function receiptAmountText(tx) {
  const n = Number(tx.amount);
  return isNaN(n) ? String(tx.amount) : n.toFixed(2);
}

// تفاصيل الحوالة + خيارات العملية في واجهة واحدة
function openTxActions(txId) {
  const tx = transactionsList.find(t => String(t.id) === String(txId));
  if (!tx) return;
  txActionsTargetId = txId;
  const svc = svcMeta(tx.service);
  // المستفيد: الاسم إن كان محفوظاً (يحل محل الرقم)، وإلا الرقم مع مربع + صغير لإضافة اسم
  let who = '';
  if (tx.name) {
    who = `<button type="button" class="rc-who-name" onclick="openTxNameEditor()" aria-label="تعديل اسم المستفيد">${escapeHtml(tx.name)}</button>`;
  } else if (tx.phone) {
    who = `<span class="rc-who-phone">${escapeHtml(tx.phone)}</span>
      <button type="button" class="rc-add-name" onclick="openTxNameEditor()" aria-label="إضافة اسم للمستفيد"><svg class="icon"><use href="#i-plus"></use></svg></button>`;
  }
  document.querySelector('.receipt-sheet').dataset.service = tx.service;
  document.getElementById('txa-summary').innerHTML = `
    <div class="rc-head">
      <div class="rc-head-text">
        <div class="rc-title">إشعار حوالة مالية</div>
        <div class="rc-date">${receiptDateText(tx.timestamp)}</div>
      </div>
      <span class="rc-badge ${tx.service}"><svg class="icon"><use href="#i-svc-wallet"></use></svg>${svc.label}</span>
    </div>
    <div class="rc-rule"></div>
    <div class="rc-amount">
      <small>المبلغ المحوَّل</small>
      <div><b>${receiptAmountText(tx)}</b><span>شيكل</span></div>
    </div>
    ${who ? `<div class="rc-who">${who}</div>` : ''}
    <div class="rc-row"><span>نوع الحركة</span><strong>${typeFullLabel(tx.type)}</strong></div>`;
  // إعادة الحركة تلزمها خدمة تحويل من التطبيق + رقم
  const repeatBtn = document.getElementById('txa-repeat-btn');
  if (repeatBtn) repeatBtn.style.display = (!isExternalOnlyTx(tx) && tx.phone) ? '' : 'none';
  closeTxNameEditor();
  cancelDeleteTransaction();
  document.getElementById('tx-actions-backdrop').style.display = 'flex';
}

function closeTxActions() {
  document.getElementById('tx-actions-backdrop').style.display = 'none';
  closeTxNameEditor();
  cancelDeleteTransaction();
  txActionsTargetId = null;
}

function openTxNameEditor() {
  const tx = transactionsList.find(t => String(t.id) === String(txActionsTargetId));
  if (!tx) return;
  document.getElementById('txa-actions').style.display = 'none';
  document.getElementById('txa-name-editor').style.display = 'block';
  const input = document.getElementById('txa-name-input');
  input.value = tx.name || '';
  input.focus();
}

function closeTxNameEditor() {
  const ed = document.getElementById('txa-name-editor');
  const act = document.getElementById('txa-actions');
  if (ed) ed.style.display = 'none';
  if (act) act.style.display = '';
}

// الاسم يخص الرقم: يُطبَّق على كل حركات نفس الرقم (الرقم يبقى محفوظاً في بيانات الحركة).
// اسم فارغ = حذف الاسم. تبقى الواجهة مفتوحة وتعرض الاسم مباشرة.
function saveTxName() {
  const tx = transactionsList.find(t => String(t.id) === String(txActionsTargetId));
  if (!tx) return;
  const name = document.getElementById('txa-name-input').value.trim();
  transactionsList.forEach(t => {
    const same = tx.phone ? t.phone === tx.phone : t === tx;
    if (!same) return;
    if (name) t.name = name; else delete t.name;
  });
  saveToStorage(STORAGE_KEYS.tx, transactionsList);
  if (name) upsertFavorite(name, tx.phone, tx.service, tx.type);
  renderHistory();
  openTxActions(txActionsTargetId);
}

function askDeleteTransaction() {
  document.getElementById('txa-actions').style.display = 'none';
  document.getElementById('txa-delete-confirm').style.display = 'block';
}
function cancelDeleteTransaction() {
  const c = document.getElementById('txa-delete-confirm');
  const act = document.getElementById('txa-actions');
  if (c) c.style.display = 'none';
  if (act && document.getElementById('txa-name-editor').style.display !== 'block') act.style.display = '';
}

// الحذف يتم بعد تأكيد المستخدم (askDeleteTransaction) مع إمكانية التراجع كالسابق
function deleteTransactionFromActions() {
  if (!txActionsTargetId) return;
  const removed = transactionsList.filter(t => String(t.id) === String(txActionsTargetId));
  transactionsList = transactionsList.filter(t => String(t.id) !== String(txActionsTargetId));
  saveToStorage(STORAGE_KEYS.tx, transactionsList);
  renderHistory();
  closeTxActions();
  showUndoSnackbar(removed);
}

// إعادة الحركة: تفتح المعالج مباشرة مع تعبئة نفس الرقم (والخدمة/النوع) فقط؛ المبلغ يُترك
// فارغاً ليُدخله المستخدم، ويمرّ التحويل بحوار المراجعة والتأكيد المعتاد (لا تنفيذ تلقائي).
function repeatTransactionFromActions() {
  const tx = transactionsList.find(t => String(t.id) === String(txActionsTargetId));
  closeTxActions();
  if (!tx) return;
  // الانتقال أولاً إلى الرئيسية (تفعيل تبويبها وإخفاء زر السجل العائم) ثم فتح التحويل الجديد
  // من هناك؛ بدونها كان المعالج يُفتح وتبويب «السجل» ما زال مفعّلاً.
  switchTab('home');
  startWizard(tx.service);
  setTimeout(() => {
    selectTransferType(tx.type);
    document.getElementById('input-phone').value = tx.phone;
    document.getElementById('input-amount').value = '';
    if (tx.name) selectedContact = { name: tx.name, phone: tx.phone };
    document.getElementById('input-amount').focus();
  }, 100);
}

// ---------- مشاركة الوصل: صورة PNG بنفس تصميم الإشعار ----------
const RECEIPT_COLORS = { jawwal: '#2A7D53', palpay: '#5F6AAE', bankpal: '#B8517A' };

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

async function renderReceiptCanvas(tx) {
  const F = '"IBM Plex Sans Arabic","Noto Sans Arabic",Tahoma,Arial,sans-serif';
  try { await Promise.all([document.fonts.load('700 28px ' + F), document.fonts.load('400 22px ' + F)]); } catch (e) {}
  const W = 720, H = 760, S = 2;
  const c = document.createElement('canvas'); c.width = W * S; c.height = H * S;
  const ctx = c.getContext('2d'); ctx.scale(S, S); ctx.direction = 'rtl';
  const col = RECEIPT_COLORS[tx.service] || '#5F6AAE';
  ctx.fillStyle = '#F8FAFC'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#FFFFFF'; rrect(ctx, 28, 28, W - 56, H - 56, 28); ctx.fill();
  ctx.strokeStyle = '#E2E8F0'; ctx.lineWidth = 2; ctx.stroke();
  const R = W - 68, L = 68;
  const text = (t, x, y, font, color, align) => { ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align || 'right'; ctx.fillText(t, x, y); };
  text('إشعار حوالة مالية', R, 100, '700 34px ' + F, '#0F172A');
  text(receiptDateText(tx.timestamp), R, 138, '400 22px ' + F, '#64748B');
  const label = svcMeta(tx.service).label;
  ctx.font = '700 24px ' + F; const bw = ctx.measureText(label).width + 44;
  ctx.fillStyle = col + '22'; rrect(ctx, L, 70, bw, 56, 18); ctx.fill();
  text(label, L + bw / 2, 107, '700 24px ' + F, col, 'center');
  ctx.fillStyle = '#0F172A'; ctx.fillRect(L, 168, W - 136, 3);
  // المبلغ
  ctx.fillStyle = '#F1F5F9'; rrect(ctx, L, 198, W - 136, 190, 24); ctx.fill();
  text('المبلغ المحوَّل', W / 2, 250, '400 24px ' + F, '#64748B', 'center');
  text(receiptAmountText(tx) + ' شيكل', W / 2, 330, '700 64px ' + F, '#0F172A', 'center');
  // المستفيد: بطاقة بعرض كامل (الاسم إن وُجد وإلا الرقم)
  const who = tx.name || tx.phone || '';
  if (who) {
    ctx.strokeStyle = '#E2E8F0'; ctx.lineWidth = 2; ctx.fillStyle = '#FFFFFF';
    rrect(ctx, L, 420, W - 136, 110, 22); ctx.fill(); ctx.stroke();
    ctx.direction = (/^[0-9+\s]+$/.test(who) ? 'ltr' : 'rtl');
    let f = 40; ctx.font = '700 ' + f + 'px ' + F;
    while (ctx.measureText(who).width > W - 136 - 60 && f > 20) { f -= 2; ctx.font = '700 ' + f + 'px ' + F; }
    text(who, W / 2, 490, '700 ' + f + 'px ' + F, '#0F172A', 'center');
    ctx.direction = 'rtl';
  }
  // نوع الحركة
  ctx.fillStyle = '#E2E8F0'; ctx.fillRect(L, 584, W - 136, 2);
  text('نوع الحركة', R, 640, '400 24px ' + F, '#64748B');
  text(typeFullLabel(tx.type), L, 640, '700 28px ' + F, '#0F172A', 'left');
  text('SwiftPay', W / 2, 712, '700 20px ' + F, '#94A3B8', 'center');
  return c;
}

async function shareReceiptFromActions() {
  const tx = transactionsList.find(t => String(t.id) === String(txActionsTargetId));
  if (!tx) return;
  let canvas;
  try { canvas = await renderReceiptCanvas(tx); } catch (e) { alert('تعذّر إنشاء الوصل'); return; }
  const fileName = 'swiftpay-receipt-' + String(tx.id).slice(0, 8) + '.png';
  const b64 = canvas.toDataURL('image/png').split(',')[1];
  try {
    if (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.FileExport) {
      await Capacitor.Plugins.FileExport.saveAndShare({ fileName: fileName, mime: 'image/png', base64: b64 });
      return;
    }
  } catch (e) { alert('تعذّرت مشاركة الوصل: ' + ((e && e.message) || '')); return; }
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  try {
    const file = new File([blob], fileName, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'وصل SwiftPay' }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
  } catch (e) { alert('تعذّرت مشاركة الوصل على هذا الجهاز'); }
}

// ================= حوالة بال باي المعلّقة =================
// بعد بدء التحويل ننتظر ~30 ثانية ثم نسأل المستخدم. لا تُسجَّل الحوالة إلا عند "نعم"،
// و"لا" لا تسجّل شيئاً (لا ناجحة ولا فاشلة). الحالة المعلّقة محفوظة بـlocalStorage
// فتبقى بعد إغلاق التطبيق أو إعادة تشغيل الهاتف، وتُعرض قبل السماح بأي عملية جديدة.
const PENDING_PALPAY_KEY = 'swiftpay_pending_palpay';
const PENDING_PALPAY_DELAY_MS = 30000;
let pendingPalpay = loadFromStorage(PENDING_PALPAY_KEY, null);
let pendingPalpayTimer = null;
let pendingPalpayAnswering = false;

function hasPendingPalpay() { return !!pendingPalpay; }
function savePendingPalpay(rec) { pendingPalpay = rec; saveToStorage(PENDING_PALPAY_KEY, rec); }
function clearPendingPalpay() {
  pendingPalpay = null;
  try { localStorage.removeItem(PENDING_PALPAY_KEY); } catch (e) {}
  if (pendingPalpayTimer) { clearTimeout(pendingPalpayTimer); pendingPalpayTimer = null; }
}

function schedulePendingPrompt() {
  if (pendingPalpayTimer) { clearTimeout(pendingPalpayTimer); pendingPalpayTimer = null; }
  if (!pendingPalpay) return;
  const wait = Math.max(0, pendingPalpay.startedAt + PENDING_PALPAY_DELAY_MS - Date.now());
  pendingPalpayTimer = setTimeout(showPendingConfirm, wait);
}

function showPendingConfirm() {
  if (!pendingPalpay) return;
  const p = pendingPalpay;
  const who = p.name ? escapeHtml(p.name) + '<small class="exec-ltr">' + escapeHtml(p.phone) + '</small>' : '<span class="exec-ltr">' + escapeHtml(p.phone) + '</span>';
  document.getElementById('pending-details').innerHTML =
    `<div class="pending-amount"><b>${escapeHtml(p.amount)}</b><span>شيكل</span></div>
     <div class="confirm-row"><span>إلى</span><span>${who}</span></div>
     <div class="confirm-row"><span>نوع الحركة</span><span>${serviceLabel(p.service)} - ${typeFullLabel(p.type)}</span></div>`;
  document.getElementById('pending-yes-btn').disabled = false;
  document.getElementById('pending-no-btn').disabled = false;
  pendingPalpayAnswering = false;
  document.getElementById('pending-confirm-backdrop').style.display = 'flex';
}

function answerPendingPalpay(success) {
  if (pendingPalpayAnswering || !pendingPalpay) return;
  pendingPalpayAnswering = true;
  const p = pendingPalpay;
  document.getElementById('pending-yes-btn').disabled = true;
  document.getElementById('pending-no-btn').disabled = true;
  // "نعم": تسجيل مرة واحدة فقط (المعرّف ثابت؛ لا تكرار حتى لو تكرر الضغط أو الاستئناف)
  if (success && !transactionsList.some(t => String(t.id) === String(p.id))) {
    addTransactionRecord(
      { service: p.service, type: p.type, phone: p.phone, amount: p.amount, name: p.name, code: p.code },
      { id: p.id, timestamp: p.startedAt }
    );
  }
  clearPendingPalpay();
  document.getElementById('pending-confirm-backdrop').style.display = 'none';
  pendingPalpayAnswering = false;
}

// عند فتح التطبيق: إن وُجدت عملية معلّقة نعرض التأكيد فوراً (وإن سُجّلت فعلاً نكتفي بمسحها)
function resumePendingPalpay() {
  if (!pendingPalpay) return;
  if (transactionsList.some(t => String(t.id) === String(pendingPalpay.id))) { clearPendingPalpay(); return; }
  showPendingConfirm();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pendingPalpay) schedulePendingPrompt();
});

function clearHistoryScope(scope) {
  const inScope = tx => {
    if (scope === 'all') return true;
    if (scope === 'view' || scope === 'month') return txInView(tx);
    return tx.service === scope;
  };
  const n = transactionsList.filter(inScope).length;
  if (n === 0) { alert('لا توجد عمليات لمسحها'); return; }
  const what = scope === 'all' ? 'كل السجل'
    : (scope === 'view' || scope === 'month') ? 'حركات ' + viewPeriodName() + ' (' + viewPeriodText() + ')'
    : 'حركات ' + METRIC_LABELS[scope];
  askConfirmDelete('سيتم مسح ' + what + ' (' + n + ' عملية).', () => {
    const removed = transactionsList.filter(inScope);
    transactionsList = transactionsList.filter(tx => !inScope(tx));
    saveToStorage(STORAGE_KEYS.tx, transactionsList);
    renderHistory();
    closeHistoryOptions();
    showUndoSnackbar(removed);
  });
}

// ---------- التراجع بعد الحذف (5 ثوانٍ) ----------
const UNDO_MS = 5000;
let undoState = null;
let undoTimer = null;

function showUndoSnackbar(removed) {
  if (!removed || !removed.length) return;
  undoState = removed;
  const bar = document.getElementById('undo-snackbar');
  document.getElementById('undo-snackbar-text').innerText = 'تم حذف ' + removed.length + ' عملية';
  bar.classList.remove('show');
  void bar.offsetWidth; // إعادة تشغيل حركة العدّاد
  bar.style.display = 'flex';
  bar.classList.add('show');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndoSnackbar, UNDO_MS);
}

function hideUndoSnackbar() {
  clearTimeout(undoTimer);
  const bar = document.getElementById('undo-snackbar');
  bar.classList.remove('show');
  bar.style.display = 'none';
  undoState = null;
}

function undoDelete() {
  if (!undoState) return;
  const restored = undoState;
  hideUndoSnackbar();
  transactionsList = transactionsList.concat(restored)
    .sort((x, y) => new Date(y.timestamp) - new Date(x.timestamp));
  saveToStorage(STORAGE_KEYS.tx, transactionsList);
  renderHistory();
}

// ---------- تصدير الحركات المعروضة (ملف Excel حقيقي .xlsx) ----------
// نبني ملف xlsx بنفسنا (ZIP بدون ضغط) كي لا نعتمد على أي مكتبة خارجية، ويعمل offline.
const XLSX_CRC_TABLE = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function xlsxCrc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = XLSX_CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function xlsxZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => [v & 255, (v >>> 8) & 255];
  const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  files.forEach(f => {
    const name = enc.encode(f.name);
    const data = enc.encode(f.data);
    const crc = xlsxCrc32(data);
    const head = new Uint8Array([
      0x50, 0x4B, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)
    ]);
    chunks.push(head, name, data);
    central.push({ name, crc, size: data.length, offset });
    offset += head.length + name.length + data.length;
  });
  const cdStart = offset;
  central.forEach(c => {
    const rec = new Uint8Array([
      0x50, 0x4B, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(c.crc), ...u32(c.size), ...u32(c.size), ...u16(c.name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset)
    ]);
    chunks.push(rec, c.name);
    offset += rec.length + c.name.length;
  });
  const cdSize = offset - cdStart;
  chunks.push(new Uint8Array([
    0x50, 0x4B, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
    ...u32(cdSize), ...u32(cdStart), ...u16(0)
  ]));
  let total = 0;
  chunks.forEach(c => { total += c.length; });
  const out = new Uint8Array(total);
  let pos = 0;
  chunks.forEach(c => { out.set(c, pos); pos += c.length; });
  return out;
}

function xlsxEsc(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function xlsxColName(i) { return String.fromCharCode(65 + i); }

function buildHistoryXlsx(rows) {
  const head = ['التاريخ', 'الوقت', 'الخدمة', 'النوع', 'الاسم', 'الرقم', 'المبلغ (شيكل)'];
  const widths = [13, 9, 13, 11, 22, 16, 15];
  // نصوص الخلايا في جدول sharedStrings (الطريقة القياسية). كان الملف السابق يخزّن النصوص
  // inlineStr وبعض تطبيقات الجوال (WPS وعارضات الملفات) تعرضها فارغة، فيظهر الملف بلا بيانات.
  const sst = [], sstIdx = {};
  let sstRefs = 0;
  const strCell = (ref, v, style) => {
    const key = String(v == null ? '' : v);
    if (!(key in sstIdx)) { sstIdx[key] = sst.length; sst.push(key); }
    sstRefs++;
    return '<c r="' + ref + '" t="s"' + (style ? ' s="' + style + '"' : '') + '><v>' + sstIdx[key] + '</v></c>';
  };
  let sheetRows = '<row r="1" ht="22" customHeight="1">' + head.map((h, i) => strCell(xlsxColName(i) + '1', h, 4)).join('') + '</row>';
  let total = 0;
  rows.forEach((tx, idx) => {
    const r = idx + 2;
    const d = new Date(tx.timestamp);
    const amount = Number(tx.amount) || 0;
    total += amount;
    const vals = [
      d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()),
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()),
      serviceLabel(tx.service),
      typeLabel(tx.type),
      tx.name || '',
      tx.phone || ''
    ];
    sheetRows += '<row r="' + r + '">' +
      vals.map((v, i) => strCell(xlsxColName(i) + r, v, 5)).join('') +
      '<c r="G' + r + '" s="2"><v>' + amount + '</v></c></row>';
  });
  const tr = rows.length + 2;
  sheetRows += '<row r="' + tr + '">' + strCell('F' + tr, 'الإجمالي', 1) +
    '<c r="G' + tr + '" s="3"><v>' + total + '</v></c></row>';

  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const sheet = XML +
    '<worksheet ' + NS + '><dimension ref="A1:G' + tr + '"/>' +
    '<sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="16"/>' +
    '<cols>' + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>' +
    '<sheetData>' + sheetRows + '</sheetData></worksheet>';
  const sstXml = XML + '<sst ' + NS + ' count="' + sstRefs + '" uniqueCount="' + sst.length + '">' +
    sst.map(t => '<si><t xml:space="preserve">' + xlsxEsc(t) + '</t></si>').join('') + '</sst>';
  const styles = XML +
    '<styleSheet ' + NS + '><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>' +
    '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right><top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="6">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="center"/></xf>' +
    '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"><alignment horizontal="center"/></xf>' +
    '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>' +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return xlsxZip([
    { name: '[Content_Types].xml', data: XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>' },
    { name: '_rels/.rels', data: XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + REL + '/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="' + REL + '/extended-properties" Target="docProps/app.xml"/></Relationships>' },
    { name: 'docProps/core.xml', data: XML + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>SwiftPay</dc:title><dc:creator>SwiftPay</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created></cp:coreProperties>' },
    { name: 'docProps/app.xml', data: XML + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>SwiftPay</Application></Properties>' },
    { name: 'xl/workbook.xml', data: XML + '<workbook ' + NS + ' xmlns:r="' + REL + '"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="20000" windowHeight="10000"/></bookViews><sheets><sheet name="SwiftPay" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + REL + '/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="' + REL + '/styles" Target="styles.xml"/><Relationship Id="rId3" Type="' + REL + '/sharedStrings" Target="sharedStrings.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/sharedStrings.xml', data: sstXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheet }
  ]);
}

function bytesToBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF_MIME = 'application/pdf';

// ---------- PDF: صفحات A4 تُرسم على canvas (لضمان صحة الحروف العربية) ثم تُضمَّن كصور JPEG ----------
async function buildHistoryPdf(rows) {
  const F = '"IBM Plex Sans Arabic","Noto Sans Arabic",Tahoma,Arial,sans-serif';
  try { await Promise.all([document.fonts.load('700 14px ' + F), document.fonts.load('400 12px ' + F), document.fonts.load('500 12px ' + F)]); } catch (e) {}
  const PW = 595, PH = 842, SC = 2, M = 36;
  const cols = [   // من اليمين إلى اليسار
    { h: 'التاريخ والوقت', w: 112, get: (tx, d) => d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + '  ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()), ltr: true },
    { h: 'الخدمة', w: 78, get: tx => serviceLabel(tx.service) },
    { h: 'النوع', w: 62, get: tx => typeLabel(tx.type) },
    { h: 'الاسم', w: 112, get: tx => tx.name || '—' },
    { h: 'الرقم', w: 80, get: tx => tx.phone || '—', ltr: true },
    { h: 'المبلغ', w: 79, get: tx => (Number(tx.amount) || 0).toFixed(2), bold: true, ltr: true }
  ];
  const tableW = PW - M * 2;
  const total = rows.reduce((a, tx) => a + (Number(tx.amount) || 0), 0);
  const first = new Date(rows[0].timestamp), last = new Date(rows[rows.length - 1].timestamp);
  const dayFmt = d => d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate());
  const filterLabel = historyFilter === 'all' ? 'كل الخدمات' : serviceLabel(historyFilter);
  const ROW_H = 26, HEAD_H = 28, FIRST_TOP = 214, NEXT_TOP = 70, FOOT = 40;
  const perFirst = Math.floor((PH - FIRST_TOP - HEAD_H - FOOT) / ROW_H);
  const perNext = Math.floor((PH - NEXT_TOP - HEAD_H - FOOT) / ROW_H);
  const pages = [];
  let i = 0;
  pages.push(rows.slice(i, i += perFirst));
  while (i < rows.length) pages.push(rows.slice(i, i += perNext));
  // صف الإجمالي يحتاج مكاناً بآخر صفحة
  if (pages[pages.length - 1].length + 1 > (pages.length === 1 ? perFirst : perNext)) pages.push([]);

  const jpegs = [];
  pages.forEach((chunk, pi) => {
    const c = document.createElement('canvas'); c.width = PW * SC; c.height = PH * SC;
    const x = c.getContext('2d'); x.scale(SC, SC); x.direction = 'rtl';
    x.fillStyle = '#FFFFFF'; x.fillRect(0, 0, PW, PH);
    const text = (t, px, py, font, color, align) => { x.font = font; x.fillStyle = color; x.textAlign = align || 'right'; x.fillText(t, px, py); };
    const rrect = (rx, ry, rw, rh, r) => { x.beginPath(); x.moveTo(rx + r, ry); x.arcTo(rx + rw, ry, rx + rw, ry + rh, r); x.arcTo(rx + rw, ry + rh, rx, ry + rh, r); x.arcTo(rx, ry + rh, rx, ry, r); x.arcTo(rx, ry, rx + rw, ry, r); x.closePath(); };
    let top;
    if (pi === 0) {
      x.fillStyle = '#0F766E'; rrect(M, M, tableW, 92, 14); x.fill();
      text('سجل حركات SwiftPay', PW - M - 18, M + 38, '700 22px ' + F, '#FFFFFF');
      text('الفترة: ' + (dayFmt(first) === dayFmt(last) ? dayFmt(first) : dayFmt(first) + '  ←  ' + dayFmt(last)) + '   •   ' + filterLabel, PW - M - 18, M + 64, '400 12px ' + F, 'rgba(255,255,255,.88)');
      text('تاريخ التقرير: ' + dayFmt(new Date()), PW - M - 18, M + 82, '400 10px ' + F, 'rgba(255,255,255,.7)');
      // بطاقتا الملخص
      const bw = (tableW - 12) / 2;
      [['عدد العمليات', String(rows.length), PW - M - bw], ['إجمالي المبالغ (شيكل)', total.toFixed(2), PW - M - bw * 2 - 12]].forEach(([k, v, bx]) => {
        x.fillStyle = '#F1F5F9'; rrect(bx, M + 106, bw, 56, 12); x.fill();
        text(k, bx + bw - 14, M + 128, '400 11px ' + F, '#64748B');
        text(v, bx + bw - 14, M + 152, '700 20px ' + F, '#0F172A');
      });
      top = FIRST_TOP;
    } else {
      text('سجل حركات SwiftPay', PW - M, M + 10, '700 13px ' + F, '#0F766E');
      top = NEXT_TOP;
    }
    // رأس الجدول
    x.fillStyle = '#0F766E'; rrect(M, top, tableW, HEAD_H, 8); x.fill();
    let cx = PW - M;
    cols.forEach(col => { text(col.h, cx - col.w / 2, top + 18, '700 11px ' + F, '#FFFFFF', 'center'); cx -= col.w; });
    // الصفوف
    chunk.forEach((tx, ri) => {
      const ry = top + HEAD_H + ri * ROW_H;
      if (ri % 2 === 0) { x.fillStyle = '#F8FAFC'; x.fillRect(M, ry, tableW, ROW_H); }
      const d = new Date(tx.timestamp);
      let px = PW - M;
      cols.forEach(col => {
        let v = String(col.get(tx, d));
        x.direction = col.ltr ? 'ltr' : 'rtl';
        let f = 11; x.font = (col.bold ? '700 ' : '400 ') + f + 'px ' + F;
        while (x.measureText(v).width > col.w - 8 && f > 7) { f -= 0.5; x.font = (col.bold ? '700 ' : '400 ') + f + 'px ' + F; }
        text(v, px - col.w / 2, ry + 17, (col.bold ? '700 ' : '400 ') + f + 'px ' + F, '#0F172A', 'center');
        x.direction = 'rtl';
        px -= col.w;
      });
      x.fillStyle = '#E2E8F0'; x.fillRect(M, ry + ROW_H - 0.5, tableW, 0.5);
    });
    // الإجمالي (آخر صفحة)
    if (pi === pages.length - 1) {
      const ry = top + HEAD_H + chunk.length * ROW_H + 4;
      x.fillStyle = '#ECFDF5'; rrect(M, ry, tableW, ROW_H + 2, 8); x.fill();
      text('الإجمالي', PW - M - 12, ry + 18, '700 12px ' + F, '#0F766E');
      x.direction = 'ltr'; text(total.toFixed(2) + ' شيكل', M + 12, ry + 18, '700 12px ' + F, '#0F766E', 'left'); x.direction = 'rtl';
    }
    // تذييل
    text('SwiftPay', M, PH - 22, '700 10px ' + F, '#94A3B8', 'left');
    text('صفحة ' + (pi + 1) + ' من ' + pages.length, PW - M, PH - 22, '400 10px ' + F, '#94A3B8');
    jpegs.push(c.toDataURL('image/jpeg', 0.92).split(',')[1]);
  });

  // ---- كتابة ملف PDF ----
  const enc = new TextEncoder();
  const parts = []; let len = 0; const offs = [];
  const push = (u8) => { parts.push(u8); len += u8.length; };
  const pushStr = (str) => push(enc.encode(str));
  const b64 = (b) => { const bin = atob(b); const u = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k); return u; };
  const n = pages.length;
  // الأرقام: 1 Catalog, 2 Pages, ثم لكل صفحة: Page, Content, Image
  pushStr('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const obj = (id, body) => { offs[id] = len; pushStr(id + ' 0 obj\n' + body + '\nendobj\n'); };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [' + pages.map((_, k) => (3 + k * 3) + ' 0 R').join(' ') + '] /Count ' + n + ' >>');
  pages.forEach((_, k) => {
    const pid = 3 + k * 3, cid = pid + 1, iid = pid + 2;
    obj(pid, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PW + ' ' + PH + '] /Resources << /XObject << /Im0 ' + iid + ' 0 R >> >> /Contents ' + cid + ' 0 R >>');
    const content = 'q ' + PW + ' 0 0 ' + PH + ' 0 0 cm /Im0 Do Q';
    obj(cid, '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
    const img = b64(jpegs[k]);
    offs[iid] = len;
    pushStr(iid + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + (PW * SC) + ' /Height ' + (PH * SC) + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + img.length + ' >>\nstream\n');
    push(img);
    pushStr('\nendstream\nendobj\n');
  });
  const xref = len; const count = 3 + n * 3;
  let xr = 'xref\n0 ' + count + '\n0000000000 65535 f \n';
  for (let id = 1; id < count; id++) xr += String(offs[id]).padStart(10, '0') + ' 00000 n \n';
  pushStr(xr + 'trailer\n<< /Size ' + count + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF');
  const out = new Uint8Array(len); let pos = 0;
  parts.forEach(p => { out.set(p, pos); pos += p.length; });
  return out;
}

async function exportHistory(kind) {
  kind = kind === 'pdf' ? 'pdf' : 'xlsx';
  const rows = transactionsList
    .filter(tx => txInView(tx) && (historyFilter === 'all' || tx.service === historyFilter))
    .sort((x, y) => new Date(x.timestamp) - new Date(y.timestamp));
  if (!rows.length) { alert('لا توجد عمليات في الفترة المعروضة'); return; }
  // اسم الملف = تاريخ الحركات نفسها (أقدم حركة وأحدث حركة)، وليس تاريخ التحميل
  const firstDay = toDateInputValue(new Date(rows[0].timestamp));
  const lastDay = toDateInputValue(new Date(rows[rows.length - 1].timestamp));
  const stamp = firstDay === lastDay ? firstDay : firstDay + '_' + lastDay;
  const fileName = 'swiftpay-' + stamp + '.' + kind;
  const mime = kind === 'pdf' ? PDF_MIME : XLSX_MIME;

  let bytes;
  try {
    bytes = kind === 'pdf' ? await buildHistoryPdf(rows) : buildHistoryXlsx(rows);
  } catch (e) {
    alert('تعذّر إنشاء الملف');
    return;
  }

  // 1) تطبيق أندرويد: حفظ في التنزيلات + نافذة المشاركة (WebView لا يدعم تنزيل blob ولا مشاركة الملفات)
  try {
    if (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.FileExport) {
      await Capacitor.Plugins.FileExport.saveAndShare({
        fileName: fileName, mime: mime, base64: bytesToBase64(bytes)
      });
      return;
    }
  } catch (e) {
    alert('تعذّر تصدير الملف: ' + ((e && e.message) || ''));
    return;
  }

  // 2) المتصفح / PWA
  try {
    const file = new File([bytes], fileName, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'سجل SwiftPay' });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    alert('تعذّر تصدير الملف على هذا الجهاز');
  }
}

function clearHistory() { clearHistoryScope('all'); }

// ================= مزامنة الأسماء مع المفضلة =================
// مفتاح مقارنة الأرقام: آخر 9 أرقام (0591234567 = +970591234567 = 970591234567)
function phoneKey(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : d;
}
// المفضلة تدعم جوال باي/بال باي وصديق/تاجر فقط (هي ما يستطيع التحويل السريع تنفيذه)
function favEligible(service, type) {
  return (service === 'jawwal' || service === 'palpay') && (type === 'friend' || type === 'merchant');
}
// دمج المكرر: يبقى أول مستفيد بهذا الرقم (بمكانه) ويأخذ أحدث اسم (الأكبر id)، ويُحذف الباقي
function mergeDuplicateFavorites() {
  const byKey = {};
  let changed = false;
  favoritesList.forEach(f => {
    const k = phoneKey(f.phone);
    if (!k) return;
    if (!byKey[k]) { byKey[k] = f; return; }
    const keep = byKey[k];
    if (f.id > keep.id && f.name) keep.name = f.name;
    f._dup = true; changed = true;
  });
  if (changed) {
    favoritesList = favoritesList.filter(f => !f._dup);
    saveToStorage(STORAGE_KEYS.fav, favoritesList);
  }
}
// إضافة اسم من السجل = المستفيد يدخل المفضلة تلقائياً. إن وُجد نفس الرقم نُحدّث اسمه بالاسم الجديد
// (هو آخر ما كتبه المستخدم) ونُبقي خدمته ونوعه، بدل إنشاء نسخة مكررة.
function upsertFavorite(name, phone, service, type) {
  if (!name || !phone || !favEligible(service, type)) return;
  const key = phoneKey(phone);
  const existing = favoritesList.find(f => phoneKey(f.phone) === key);
  if (existing) {
    existing.name = name;
    favoritesList = favoritesList.filter(f => f === existing || phoneKey(f.phone) !== key);
  } else {
    favoritesList.push({ id: Date.now(), name: name, phone: phone, service: service, type: type });
  }
  saveToStorage(STORAGE_KEYS.fav, favoritesList);
  renderFavorites();
}

// ================= تأكيد الحذف (موحّد) =================
let confirmDeleteAction = null;
function askConfirmDelete(text, action) {
  confirmDeleteAction = action;
  document.getElementById('confirm-delete-text').innerText = text || '';
  document.getElementById('confirm-delete-backdrop').style.display = 'flex';
}
function closeConfirmDelete() {
  document.getElementById('confirm-delete-backdrop').style.display = 'none';
  confirmDeleteAction = null;
}
function runConfirmDelete() {
  const act = confirmDeleteAction;
  closeConfirmDelete();
  if (act) act();
}

let editingFavId = null; // null = إضافة جديدة، غير ذلك = تعديل مستفيد موجود

function setFavModalMode(editing) {
  document.getElementById('fav-modal-title').innerText = editing ? 'تعديل بيانات المستفيد' : 'إضافة مستفيد للمفضلة';
  document.getElementById('fav-modal-desc').innerText = editing
    ? 'غيّر الاسم أو الرقم، والتحويلات القادمة بتروح للرقم الجديد'
    : 'احفظ بيانات مستفيد لتحويل سريع لاحقاً';
}

function showAddFavoriteModal() {
  editingFavId = null;
  setFavModalMode(false);
  document.getElementById('add-favorite-modal').style.display = 'flex';
}

// تعديل مستفيد: نفس نافذة الإضافة لكن معبّأة ببياناته الحالية
function showEditFavoriteModal(id) {
  const fav = favoritesList.find(f => f.id === id);
  if (!fav) return;
  editingFavId = id;
  setFavModalMode(true);
  document.getElementById('fav-name').value = fav.name || '';
  document.getElementById('fav-phone').value = fav.phone || '';
  document.getElementById('fav-service').value = fav.service;
  document.getElementById('fav-type').value = fav.type;
  document.getElementById('add-favorite-modal').style.display = 'flex';
}

function hideAddFavoriteModal() {
  document.getElementById('add-favorite-modal').style.display = 'none';
  document.getElementById('fav-name').value = '';
  document.getElementById('fav-phone').value = '';
  editingFavId = null;
}

function saveNewFavorite() {
  const name = document.getElementById('fav-name').value.trim();
  const phone = document.getElementById('fav-phone').value.trim();
  if (!name || !phone) { alert('الرجاء إدخال الاسم ورقم الهاتف!'); return; }
  const service = document.getElementById('fav-service').value;
  const type = document.getElementById('fav-type').value;

  const key = phoneKey(phone);
  if (editingFavId !== null) {
    const fav = favoritesList.find(f => f.id === editingFavId);
    if (fav) {
      Object.assign(fav, { name, phone, service, type });
      // لو صار رقمه مطابقاً لمستفيد آخر: ندمجهما في هذا المستفيد (بالاسم الجديد)
      favoritesList = favoritesList.filter(f => f === fav || phoneKey(f.phone) !== key);
    }
  } else {
    const existing = favoritesList.find(f => phoneKey(f.phone) === key);
    if (existing) {
      Object.assign(existing, { name, phone, service, type });
      favoritesList = favoritesList.filter(f => f === existing || phoneKey(f.phone) !== key);
    } else {
      favoritesList.push({ id: Date.now(), name, phone, service, type });
    }
  }
  saveToStorage(STORAGE_KEYS.fav, favoritesList);
  renderFavorites();
  hideAddFavoriteModal();
}

function deleteFavorite(id, event) {
  event.stopPropagation();
  const fav = favoritesList.find(item => item.id === id);
  if (!fav) return;
  askConfirmDelete('سيتم حذف «' + (fav.name || fav.phone) + '» من المفضلة.', () => {
    favoritesList = favoritesList.filter(item => item.id !== id);
    saveToStorage(STORAGE_KEYS.fav, favoritesList);
    renderFavorites();
  });
}

function renderFavorites() {
  const container = document.getElementById('favorites-list');
  if (favoritesList.length === 0) {
    container.innerHTML = '<div class="empty-state">لم تقم بإضافة أي مستفيد حتى الآن<br><span style="font-size:0.75rem; color:var(--secondary);">اضغط على (+ إضافة) في الأعلى لتسجيل اسم ورقم</span></div>';
    return;
  }

  const hint = '<div class="fav-hint">اضغط ضغطتين على المستفيد لتعديل اسمه أو رقمه</div>';
  container.innerHTML = hint + favoritesList.map(fav => {
    const sName = fav.service === 'jawwal' ? 'جوال باي' : 'بال باي';
    const tName = fav.type === 'friend' ? 'صديق' : 'تاجر';
    const iconChar = svcGlyph(fav.service);
    return `
      <div class="favorite-card" onclick="onFavoriteTap(${fav.id})">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div class="tx-icon ${fav.service}">${iconChar}</div>
          <div>
            <h4 style="font-size: 0.95rem;">${escapeHtml(fav.name)}</h4>
            <p style="font-size: 0.75rem; color: var(--text-secondary);">${sName} (${tName}) - ${escapeHtml(fav.phone)}</p>
          </div>
        </div>
        <button class="fav-del-btn" onclick="deleteFavorite(${fav.id}, event)"><svg class="icon"><use href="#i-trash-can"></use></svg></button>
      </div>
    `;
  }).join('');
}

// ضغطة وحدة = تحويل سريع، ضغطتين = تعديل. ننتظر لحظة بعد الضغطة الأولى لنعرف إن كانت ستأتي ثانية.
const DOUBLE_TAP_MS = 320;
let favTapTimer = null;
let favTapId = null;

function onFavoriteTap(id) {
  if (favTapTimer && favTapId === id) {
    clearTimeout(favTapTimer);
    favTapTimer = null; favTapId = null;
    showEditFavoriteModal(id);
    return;
  }
  clearTimeout(favTapTimer);
  favTapId = id;
  favTapTimer = setTimeout(() => {
    favTapTimer = null; favTapId = null;
    const fav = favoritesList.find(f => f.id === id);
    if (fav) quickTransfer(fav.service, fav.type, fav.phone);
  }, DOUBLE_TAP_MS);
}

function quickTransfer(service, type, phone) {
  startWizard(service);
  setTimeout(() => { selectTransferType(type); document.getElementById('input-phone').value = phone; }, 100);
}


// ================= تسجيل تحويل خارجي (نُفّذ خارج التطبيق) =================
function nowForDateTimeInput() {
  const d = new Date();
  return toDateInputValue(d) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function openExternalTx() {
  ['ext-name', 'ext-phone', 'ext-amount'].forEach(id => {
    const el = document.getElementById(id);
    el.value = '';
    clearFieldError(el);
  });
  clearFieldError(document.getElementById('ext-when'));
  document.getElementById('ext-service').value = (historyFilter === 'palpay') ? 'palpay' : 'jawwal';
  document.getElementById('ext-type').value = 'friend';
  const when = document.getElementById('ext-when');
  when.max = nowForDateTimeInput();
  when.value = nowForDateTimeInput();
  document.getElementById('ext-tx-backdrop').style.display = 'flex';
}

function closeExternalTx() {
  document.getElementById('ext-tx-backdrop').style.display = 'none';
}

// الاسم والرقم: يكفي واحد منهما (لا بد من أحدهما على الأقل)
function saveExternalTx() {
  const nameEl = document.getElementById('ext-name');
  const phoneEl = document.getElementById('ext-phone');
  const amountEl = document.getElementById('ext-amount');
  const whenEl = document.getElementById('ext-when');
  clearFieldError(nameEl);
  clearFieldError(phoneEl);
  clearFieldError(amountEl);
  clearFieldError(whenEl);

  const name = nameEl.value.trim();
  const rawPhone = phoneEl.value.trim();
  const phone = rawPhone ? normalizePalestinePhone(rawPhone) : '';
  const amount = amountEl.value.trim().replace(',', '.');
  const when = whenEl.value ? new Date(whenEl.value) : new Date();
  let firstInvalid = null;

  if (!name && !rawPhone) {
    showFieldError(nameEl, 'اكتب الاسم أو الرقم على الأقل');
    firstInvalid = nameEl;
  } else if (rawPhone && !/^0\d{8,9}$/.test(phone)) {
    showFieldError(phoneEl, 'أدخل رقم هاتف صحيح (مثال: 0591234567)');
    firstInvalid = phoneEl;
  }
  if (amount === '' || isNaN(amount) || Number(amount) <= 0) {
    showFieldError(amountEl, 'أدخل مبلغاً صحيحاً أكبر من صفر');
    firstInvalid = firstInvalid || amountEl;
  }
  if (isNaN(when.getTime()) || when.getTime() > Date.now() + 60000) {
    showFieldError(whenEl, 'اختر تاريخاً ووقتاً صحيحين (لا يمكن أن يكونا بالمستقبل)');
    firstInvalid = firstInvalid || whenEl;
  }
  if (firstInvalid) { firstInvalid.focus(); return; }

  const service = document.getElementById('ext-service').value;
  const rec = {
    id: (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2))),
    service: service,
    type: document.getElementById('ext-type').value,
    phone: phone,
    amount: String(Number(amount)),
    timestamp: when.getTime(),
    code: null
  };
  // الاسم: المكتوب هنا، وإلا اسم محفوظ لنفس الرقم (إن وُجد رقم)
  const known = name || (phone ? ((transactionsList.find(t => t.phone === phone && t.name) || {}).name || resolveBeneficiaryName(phone)) : '');
  if (known) rec.name = known;

  transactionsList.push(rec);
  transactionsList.sort((x, y) => new Date(y.timestamp) - new Date(x.timestamp));
  saveToStorage(STORAGE_KEYS.tx, transactionsList);
  if (name && phone) upsertFavorite(name, phone, rec.service, rec.type);
  renderHistory();
  closeExternalTx();
}

// مقارنة المبلغ بالرصيد أثناء الكتابة
(function () {
  const amountEl = document.getElementById('input-amount');
  if (amountEl) amountEl.addEventListener('input', validateAmountAgainstBalance);
})();
