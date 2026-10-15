package ai.wazir.mobile.persistence

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import ai.wazir.mobile.domain.ControllerProfile
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Entity(tableName = "controller_profiles")
data class ControllerProfileEntity(
    @PrimaryKey val id: String,
    val name: String,
    val baseUrl: String,
    val deviceId: String,
    val scopesJson: String,
    val tlsCertFingerprint: String?,
    val controllerVersion: String,
    val apiVersion: String,
    val pairedAt: Long,
    val lastConnectedAt: Long?,
) {
    fun toDomain(json: Json): ControllerProfile {
        val scopes = try {
            json.decodeFromString<List<String>>(scopesJson)
        } catch (_: Exception) {
            listOf("read", "mutate", "execute")
        }
        return ControllerProfile(
            id = id,
            name = name,
            baseUrl = baseUrl,
            deviceId = deviceId,
            scopes = scopes,
            tlsCertFingerprint = tlsCertFingerprint,
            controllerVersion = controllerVersion,
            apiVersion = apiVersion,
            pairedAt = pairedAt,
            lastConnectedAt = lastConnectedAt,
        )
    }

    companion object {
        fun fromDomain(profile: ControllerProfile, json: Json): ControllerProfileEntity =
            ControllerProfileEntity(
                id = profile.id,
                name = profile.name,
                baseUrl = profile.baseUrl,
                deviceId = profile.deviceId,
                scopesJson = json.encodeToString(profile.scopes),
                tlsCertFingerprint = profile.tlsCertFingerprint,
                controllerVersion = profile.controllerVersion,
                apiVersion = profile.apiVersion,
                pairedAt = profile.pairedAt,
                lastConnectedAt = profile.lastConnectedAt,
            )
    }
}

@Entity(tableName = "cached_controller_snapshots")
data class CachedControllerSnapshotEntity(
    @PrimaryKey val controllerId: String,
    val dashboardJson: String? = null,
    val tasksJson: String? = null,
    val approvalsJson: String? = null,
    val modelsJson: String? = null,
    val runtimesJson: String? = null,
    val agentsJson: String? = null,
    val computersJson: String? = null,
    val resourcesJson: String? = null,
    val lastSequence: Long = 0L,
    val syncedAtMs: Long = System.currentTimeMillis(),
)

@Entity(
    tableName = "cached_task_details",
    primaryKeys = ["controllerId", "taskId"],
)
data class CachedTaskDetailEntity(
    val controllerId: String,
    val taskId: String,
    val detailJson: String,
    val syncedAtMs: Long = System.currentTimeMillis(),
)

@Dao
interface WazirCacheDao {
    @Query("SELECT * FROM controller_profiles ORDER BY pairedAt ASC")
    fun observeControllers(): Flow<List<ControllerProfileEntity>>

    @Query("SELECT * FROM controller_profiles ORDER BY pairedAt ASC")
    suspend fun listControllers(): List<ControllerProfileEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertController(entity: ControllerProfileEntity)

    @Query("DELETE FROM controller_profiles WHERE id = :controllerId")
    suspend fun deleteController(controllerId: String)

    @Query("SELECT * FROM cached_controller_snapshots WHERE controllerId = :controllerId LIMIT 1")
    suspend fun getSnapshot(controllerId: String): CachedControllerSnapshotEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSnapshot(snapshot: CachedControllerSnapshotEntity)

    @Query("DELETE FROM cached_controller_snapshots WHERE controllerId = :controllerId")
    suspend fun deleteSnapshot(controllerId: String)

    @Query("SELECT * FROM cached_task_details WHERE controllerId = :controllerId AND taskId = :taskId LIMIT 1")
    suspend fun getTaskDetail(controllerId: String, taskId: String): CachedTaskDetailEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTaskDetail(entity: CachedTaskDetailEntity)

    @Query("DELETE FROM cached_task_details WHERE controllerId = :controllerId")
    suspend fun deleteTaskDetailsForController(controllerId: String)

    @Query(
        """
        DELETE FROM cached_task_details
        WHERE controllerId = :controllerId
          AND taskId NOT IN (
            SELECT taskId FROM cached_task_details
            WHERE controllerId = :controllerId
            ORDER BY syncedAtMs DESC
            LIMIT :maxCount
          )
        """
    )
    suspend fun pruneTaskDetails(controllerId: String, maxCount: Int = 50)
}

@Database(
    entities = [
        ControllerProfileEntity::class,
        CachedControllerSnapshotEntity::class,
        CachedTaskDetailEntity::class,
    ],
    version = 1,
    exportSchema = false,
)
abstract class WazirDatabase : RoomDatabase() {
    abstract fun cacheDao(): WazirCacheDao

    companion object {
        @Volatile
        private var INSTANCE: WazirDatabase? = null

        fun getInstance(context: Context): WazirDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    WazirDatabase::class.java,
                    "wazir_mobile_cache.db",
                )
                    .fallbackToDestructiveMigration()
                    .build()
                    .also { INSTANCE = it }
            }
        }
    }
}
