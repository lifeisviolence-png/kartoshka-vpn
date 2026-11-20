package com.plugin.vpn

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Stores the last tunnel bundle (Xray JSON plus split-tunnelling choices) with
 * an AES-256-GCM key that never leaves Android Keystore.
 *
 * The bundle is only used for the always-on null-intent start and for the Quick
 * Settings tile. A missing or invalidated key is not fatal: [load] clears the
 * unusable record, returns null and the UI asks the user to connect again.
 */
class SecureConfigStore(context: Context) {
    companion object {
        private const val TAG = "KPV_PHASE1"
        private const val PREFS = "kpv_secure_config"
        private const val KEY_ALIAS = "kpv_tunnel_config_v1"
        private const val CIPHER = "AES/GCM/NoPadding"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val IV_FIELD = "iv"
        private const val DATA_FIELD = "data"
    }

    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Volatile
    var lastError: String? = null
        private set

    fun save(bundle: String): Boolean {
        return try {
            val cipher = Cipher.getInstance(CIPHER)
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val encrypted = cipher.doFinal(bundle.toByteArray(Charsets.UTF_8))
            prefs.edit()
                .putString(IV_FIELD, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .putString(DATA_FIELD, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .apply()
            lastError = null
            true
        } catch (error: Throwable) {
            // Do not log the bundle or the key. Only the exception class.
            lastError = error.javaClass.simpleName
            Log.w(TAG, "secure config save failed: ${error.javaClass.simpleName}")
            false
        }
    }

    fun load(): String? {
        val iv = prefs.getString(IV_FIELD, null) ?: return null
        val data = prefs.getString(DATA_FIELD, null) ?: return null
        return try {
            val cipher = Cipher.getInstance(CIPHER)
            cipher.init(
                Cipher.DECRYPT_MODE,
                key(),
                GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP))
            )
            String(cipher.doFinal(Base64.decode(data, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (error: GeneralSecurityException) {
            // KeyPermanentlyInvalidatedException, AEADBadTagException and a
            // deleted key all mean the same to the user: reconnect once.
            clear()
            lastError = "Ключ Android Keystore недоступен. Подключитесь заново."
            Log.w(TAG, "secure config unavailable: ${error.javaClass.simpleName}")
            null
        } catch (error: Throwable) {
            clear()
            lastError = "Сохранённый конфиг повреждён. Подключитесь заново."
            Log.w(TAG, "secure config load failed: ${error.javaClass.simpleName}")
            null
        }
    }

    fun clear() {
        prefs.edit().remove(IV_FIELD).remove(DATA_FIELD).apply()
    }

    fun hasConfig(): Boolean = prefs.contains(DATA_FIELD)

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = keyStore.getKey(KEY_ALIAS, null)
        if (existing is SecretKey) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // No user authentication: always-on must connect before the
                // first unlock? The key is still non-exportable and tied to
                // this app's UID. A device without a secure lock screen still
                // gets Keystore protection, not a user-bound key.
                .setUserAuthenticationRequired(false)
                .build()
        )
        return generator.generateKey()
    }
}
