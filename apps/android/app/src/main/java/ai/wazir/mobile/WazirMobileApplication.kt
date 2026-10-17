package ai.wazir.mobile

import android.app.Application
import ai.wazir.mobile.notifications.ControllerSyncWorker
import ai.wazir.mobile.notifications.WazirNotificationManager

class WazirMobileApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        WazirNotificationManager(this) // ensures channels exist
        ControllerSyncWorker.schedulePeriodicSync(this)
    }
}
