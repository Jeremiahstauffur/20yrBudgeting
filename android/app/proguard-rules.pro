# Keep JavaScript interface methods for AndroidBiometric
-keepclassmembers class com.twentyyearbudgeting.app.MainActivity$BiometricJsBridge {
    @android.webkit.JavascriptInterface <methods>;
}
