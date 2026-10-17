# Keep kotlinx.serialization generated serializers
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class ai.wazir.mobile.**$$serializer { *; }
-keepclassmembers class ai.wazir.mobile.** {
    *** Companion;
}
-keepclasseswithmembers class ai.wazir.mobile.** {
    kotlinx.serialization.KSerializer serializer(...);
}
