package com.nadidstudio.swiftpay;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.telephony.TelephonyManager;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import java.util.List;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "UssdDialer",
    permissions = {
        @Permission(strings = {
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_PHONE_STATE
        }, alias = "phonePerms")
    }
)
public class UssdPlugin extends Plugin {

    // بعض المشغّلين/الأجهزة (خصوصاً أجهزة معينة بمودمات Xiaomi/Huawei) لا تستدعي
    // أياً من callbacks الـsendUssdRequest إطلاقاً في حالات نادرة، فيبقى الـPluginCall
    // معلّقاً للأبد ويظهر للمستخدم كشاشة "جاري تنفيذ التحويل..." عالقة بلا نهاية.
    // هذه المهلة تضمن رداً حتمياً دائماً خلال 30 ثانية كحد أقصى.
    private static final long USSD_TIMEOUT_MS = 30000;

    @PluginMethod
    public void dial(PluginCall call) {
        String code = call.getString("code");
        if (code == null || code.isEmpty()) {
            call.reject("code مطلوب");
            return;
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            JSObject ret = new JSObject();
            ret.put("supported", false);
            call.resolve(ret);
            return;
        }

        if (!hasRequiredPermissions()) {
            requestAllPermissions(call, "phonePermsCallback");
            return;
        }
        performDial(call, code);
    }

    @PermissionCallback
    private void phonePermsCallback(PluginCall call) {
        String code = call.getString("code");
        if (!hasRequiredPermissions() || code == null || code.isEmpty()) {
            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("permissionGranted", false);
            call.resolve(ret);
            return;
        }
        performDial(call, code);
    }

    private void performDial(PluginCall call, String code) {
        try {
            TelephonyManager telephonyManager =
                (TelephonyManager) getContext().getSystemService(Context.TELEPHONY_SERVICE);

            // الشريحة: لا نفترض أبداً أن الأولى هي الصحيحة، ولا نبدّل شريحة بأخرى بصمت.
            // نستخدم فقط الشريحة التي اختارها المستخدم (subscriptionId)، أو الشريحة الوحيدة
            // إن كان في الجهاز شريحة واحدة. أي حالة أخرى = لا يُنفَّذ شيء ويُرجَع simError.
            SimResolution sim = resolveSim(call);
            if (sim.info == null) {
                resolveSimError(call, sim.error);
                return;
            }
            telephonyManager = telephonyManager.createForSubscriptionId(sim.info.getSubscriptionId());

            // حارس ضد استدعاء call.resolve أكثر من مرة (سباق بين رد الشبكة الحقيقي
            // ومهلة الانتظار إن وصلا بنفس اللحظة تقريباً).
            final java.util.concurrent.atomic.AtomicBoolean resolved =
                new java.util.concurrent.atomic.AtomicBoolean(false);
            final Handler mainHandler = new Handler(Looper.getMainLooper());

            final Runnable timeoutRunnable = () -> {
                if (resolved.compareAndSet(false, true)) {
                    JSObject ret = new JSObject();
                    ret.put("supported", true);
                    ret.put("permissionGranted", true);
                    ret.put("timedOut", true);
                    call.resolve(ret);
                }
            };
            mainHandler.postDelayed(timeoutRunnable, USSD_TIMEOUT_MS);

            telephonyManager.sendUssdRequest(
                code,
                new TelephonyManager.UssdResponseCallback() {
                    @Override
                    public void onReceiveUssdResponse(
                            TelephonyManager tm, String request, CharSequence response) {
                        if (!resolved.compareAndSet(false, true)) return;
                        mainHandler.removeCallbacks(timeoutRunnable);
                        JSObject ret = new JSObject();
                        ret.put("supported", true);
                        ret.put("permissionGranted", true);
                        ret.put("response", response.toString());
                        call.resolve(ret);
                    }

                    @Override
                    public void onReceiveUssdResponseFailed(
                            TelephonyManager tm, String request, int failureCode) {
                        if (!resolved.compareAndSet(false, true)) return;
                        mainHandler.removeCallbacks(timeoutRunnable);
                        JSObject ret = new JSObject();
                        ret.put("supported", true);
                        ret.put("permissionGranted", true);
                        ret.put("failureCode", failureCode);
                        call.resolve(ret);
                    }
                },
                mainHandler
            );
        } catch (SecurityException e) {
            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("permissionGranted", false);
            call.resolve(ret);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("permissionGranted", true);
            ret.put("error", e.getMessage() != null ? e.getMessage() : "ussd_error");
            call.resolve(ret);
        }
    }

    // ===== جلسة تفاعلية حقيقية (بال بي) عبر ACTION_CALL =====
    // بخلاف dial() أعلاه (sendUssdRequest: طلب واحد/رد واحد فقط)، هذه الطريقة
    // تطلب الاتصال مباشرة عبر ACTION_CALL بنفس صلاحية CALL_PHONE الممنوحة
    // أصلاً أعلاه. أندرويد يتعرف تلقائياً على أكواد USSD/MMI ويعرض حواره
    // الخاص بالجلسة (يدعم عدة جولات: رمز سري ثم تأكيد) كنافذة عائمة فوق
    // التطبيق الحالي — لا ننتقل فعلياً لتطبيق الهاتف، ولا يوجد رد برمجي
    // نقرأه هنا (أندرويد لا يوفر callback لهذا المسار)، لذلك الجافاسكربت
    // يعتمد على armPendingResultWatcher()/التقاط الإشعارات لتحديد النتيجة
    // لاحقاً، تماماً كما كان يحدث سابقاً مع أسلوب tel: القديم.
    @PluginMethod
    public void dialInteractive(PluginCall call) {
        String code = call.getString("code");
        if (code == null || code.isEmpty()) {
            call.reject("code مطلوب");
            return;
        }
        if (!hasRequiredPermissions()) {
            requestAllPermissions(call, "phonePermsCallbackInteractive");
            return;
        }
        performInteractiveCall(call, code);
    }

    @PermissionCallback
    private void phonePermsCallbackInteractive(PluginCall call) {
        String code = call.getString("code");
        if (!hasRequiredPermissions() || code == null || code.isEmpty()) {
            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("permissionGranted", false);
            call.resolve(ret);
            return;
        }
        performInteractiveCall(call, code);
    }

    private void performInteractiveCall(PluginCall call, String code) {
        try {
            SimResolution sim = resolveSim(call);
            if (sim.info == null) {
                resolveSimError(call, sim.error);
                return;
            }

            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_CALL);
            intent.setData(android.net.Uri.parse("tel:" + android.net.Uri.encode(code)));

            // ربط الاتصال بالشريحة المختارة. إن تعذّر إيجاد حساب الاتصال المطابق فلا نخمّن:
            // نكمل فقط إذا كانت المختارة هي شريحة الاتصال الافتراضية في النظام (فسيستخدمها أندرويد
            // حتماً)، وإلا نوقف العملية برسالة واضحة بدل الاتصال من شريحة أخرى.
            int subId = sim.info.getSubscriptionId();
            PhoneAccountHandle handle = findPhoneAccountHandle(sim.info);
            if (handle != null) {
                intent.putExtra(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle);
            } else if (SubscriptionManager.getDefaultVoiceSubscriptionId() != subId) {
                resolveSimError(call, "sim_bind_failed");
                return;
            }

            android.app.Activity activity = getActivity();
            if (activity != null) {
                // بدون NEW_TASK: الاتصال يُطلق من نفس نشاط SwiftPay الحالي، فلا
                // يُنشئ أندرويد Task منفصلاً يبدو للمستخدم كتبديل تطبيق كامل.
                activity.startActivity(intent);
            } else {
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            }

            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("permissionGranted", true);
            ret.put("dialed", true);
            call.resolve(ret);
        } catch (SecurityException e) {
            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("permissionGranted", false);
            call.resolve(ret);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("permissionGranted", true);
            ret.put("error", e.getMessage() != null ? e.getMessage() : "dial_error");
            call.resolve(ret);
        }
    }

    // ===== إدارة شرائح SIM =====

    private static final class SimResolution {
        SubscriptionInfo info;
        String error;
    }

    // الشرائح الفعّالة، أو null إن لم تتوفر الصلاحية/الخدمة.
    private List<SubscriptionInfo> activeSubs() {
        try {
            if (getContext().checkSelfPermission(Manifest.permission.READ_PHONE_STATE)
                    != PackageManager.PERMISSION_GRANTED) {
                return null;
            }
            SubscriptionManager sm = (SubscriptionManager) getContext().getSystemService(
                Context.TELEPHONY_SUBSCRIPTION_SERVICE);
            if (sm == null) return null;
            return sm.getActiveSubscriptionInfoList();
        } catch (SecurityException e) {
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    // تحديد الشريحة المطلوبة دون أي افتراض أو بديل تلقائي:
    //  - لا شرائح فعّالة                        -> no_sim
    //  - لم يُرسَل subscriptionId وفي الجهاز 2+ -> needs_selection
    //  - لم يُرسَل subscriptionId وشريحة واحدة  -> هي الشريحة
    //  - subscriptionId غير موجود (أُخرجت)      -> sim_unavailable
    //  - موجود لكن مكانه (slot) تغيّر            -> sim_changed
    private SimResolution resolveSim(PluginCall call) {
        SimResolution r = new SimResolution();
        List<SubscriptionInfo> subs = activeSubs();
        if (subs == null || subs.isEmpty()) {
            r.error = "no_sim";
            return r;
        }
        Integer wantedId = call.getInt("subscriptionId");
        Integer wantedSlot = call.getInt("slotIndex");
        if (wantedId == null) {
            if (subs.size() == 1) {
                r.info = subs.get(0);
            } else {
                r.error = "needs_selection";
            }
            return r;
        }
        for (SubscriptionInfo info : subs) {
            if (info.getSubscriptionId() == wantedId.intValue()) {
                if (wantedSlot != null && info.getSimSlotIndex() != wantedSlot.intValue()) {
                    r.error = "sim_changed";
                    return r;
                }
                r.info = info;
                return r;
            }
        }
        r.error = "sim_unavailable";
        return r;
    }

    private void resolveSimError(PluginCall call, String error) {
        JSObject ret = new JSObject();
        ret.put("supported", true);
        ret.put("permissionGranted", true);
        ret.put("simError", error);
        call.resolve(ret);
    }

    // حساب الاتصال (PhoneAccountHandle) المطابق للشريحة، أو null إن تعذّر التأكد.
    private PhoneAccountHandle findPhoneAccountHandle(SubscriptionInfo info) {
        try {
            TelecomManager telecom = (TelecomManager) getContext().getSystemService(Context.TELECOM_SERVICE);
            if (telecom == null) return null;
            List<PhoneAccountHandle> handles = telecom.getCallCapablePhoneAccounts();
            if (handles == null || handles.isEmpty()) return null;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                TelephonyManager base =
                    (TelephonyManager) getContext().getSystemService(Context.TELEPHONY_SERVICE);
                for (PhoneAccountHandle h : handles) {
                    if (base.getSubscriptionId(h) == info.getSubscriptionId()) return h;
                }
                return null;
            }

            // أندرويد أقدم من 11: المطابقة الموثوقة الوحيدة هي ICCID إن كان متاحاً.
            String icc = info.getIccId();
            if (icc != null && !icc.isEmpty()) {
                for (PhoneAccountHandle h : handles) {
                    String id = h.getId();
                    if (id != null && (id.equals(icc) || id.startsWith(icc))) return h;
                }
            }
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    // قائمة الشرائح الفعّالة لعرضها واختيار إحداها.
    @PluginMethod
    public void getSims(PluginCall call) {
        if (!hasRequiredPermissions()) {
            requestAllPermissions(call, "simsPermsCallback");
            return;
        }
        returnSims(call);
    }

    @PermissionCallback
    private void simsPermsCallback(PluginCall call) {
        if (!hasRequiredPermissions()) {
            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("permissionGranted", false);
            ret.put("sims", new JSArray());
            call.resolve(ret);
            return;
        }
        returnSims(call);
    }

    private void returnSims(PluginCall call) {
        JSObject ret = new JSObject();
        JSArray arr = new JSArray();
        try {
            List<SubscriptionInfo> subs = activeSubs();
            if (subs != null) {
                for (SubscriptionInfo info : subs) {
                    JSObject o = new JSObject();
                    o.put("subscriptionId", info.getSubscriptionId());
                    o.put("slotIndex", info.getSimSlotIndex());
                    CharSequence carrier = info.getCarrierName();
                    CharSequence display = info.getDisplayName();
                    o.put("carrierName", carrier != null ? carrier.toString() : "");
                    o.put("displayName", display != null ? display.toString() : "");
                    String number = "";
                    try {
                        String n = info.getNumber();
                        if (n != null) number = n;
                    } catch (Exception ignored) {
                    }
                    o.put("number", number);
                    arr.put(o);
                }
            }
        } catch (Exception ignored) {
        }
        ret.put("supported", true);
        ret.put("permissionGranted", true);
        ret.put("sims", arr);
        ret.put("defaultVoiceSubId", SubscriptionManager.getDefaultVoiceSubscriptionId());
        call.resolve(ret);
    }

}
