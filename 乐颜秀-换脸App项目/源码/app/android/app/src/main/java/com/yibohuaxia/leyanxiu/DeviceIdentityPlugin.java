package com.yibohuaxia.leyanxiu;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;

@CapacitorPlugin(name = "DeviceIdentity")
public class DeviceIdentityPlugin extends Plugin {
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "leyanxiu_device_identity_p256_v1";
    private static final int MAX_CHALLENGE_BYTES = 4096;

    @PluginMethod
    public void getPublicKey(PluginCall call) {
        execute(() -> {
            try {
                KeyPair pair = getOrCreateKeyPair();
                ECPublicKey publicKey = (ECPublicKey) pair.getPublic();
                JSObject result = new JSObject();
                result.put("algorithm", "ES256");
                result.put("keyId", KEY_ALIAS);
                result.put("publicKeySpki", base64Url(publicKey.getEncoded()));
                call.resolve(result);
            } catch (Exception error) {
                call.reject("设备身份密钥不可用", "DEVICE_KEY_UNAVAILABLE", error);
            }
        });
    }

    @PluginMethod
    public void signChallenge(PluginCall call) {
        execute(() -> {
            try {
                String challenge = call.getString("challenge", "");
                byte[] challengeBytes = challenge.getBytes(StandardCharsets.UTF_8);
                if (challengeBytes.length < 16 || challengeBytes.length > MAX_CHALLENGE_BYTES) {
                    throw new IllegalArgumentException("Challenge must contain 16-4096 UTF-8 bytes");
                }
                KeyPair pair = getOrCreateKeyPair();
                Signature signer = Signature.getInstance("SHA256withECDSA");
                signer.initSign(pair.getPrivate());
                signer.update(challengeBytes);
                JSObject result = new JSObject();
                result.put("algorithm", "ES256");
                result.put("keyId", KEY_ALIAS);
                result.put("signature", base64Url(signer.sign()));
                result.put("encoding", "base64url-der");
                call.resolve(result);
            } catch (Exception error) {
                call.reject("设备身份签名失败", "DEVICE_SIGN_FAILED", error);
            }
        });
    }

    private KeyPair getOrCreateKeyPair() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            KeyStore.PrivateKeyEntry entry = (KeyStore.PrivateKeyEntry) keyStore.getEntry(KEY_ALIAS, null);
            return new KeyPair(entry.getCertificate().getPublicKey(), (PrivateKey) entry.getPrivateKey());
        }

        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE);
        KeyGenParameterSpec specification = new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY
        )
            .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false)
            .setInvalidatedByBiometricEnrollment(false)
            .build();
        generator.initialize(specification);
        return generator.generateKeyPair();
    }

    private static String base64Url(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }
}
