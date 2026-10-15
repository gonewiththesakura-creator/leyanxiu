package com.yibohuaxia.leyanxiu;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

@CapacitorPlugin(
    name = "MediaStore",
    permissions = {
        @Permission(
            strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE },
            alias = GalleryMediaStorePlugin.LEGACY_STORAGE
        )
    }
)
public class GalleryMediaStorePlugin extends Plugin {
    static final String LEGACY_STORAGE = "legacyStorage";
    private static final String ALBUM_NAME = "乐颜秀";

    @PluginMethod
    public void save(PluginCall call) {
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
            && getPermissionState(LEGACY_STORAGE) != PermissionState.GRANTED) {
            requestPermissionForAlias(LEGACY_STORAGE, call, "legacyStorageCallback");
            return;
        }
        saveWithGrantedPermission(call);
    }

    @PermissionCallback
    private void legacyStorageCallback(PluginCall call) {
        if (getPermissionState(LEGACY_STORAGE) != PermissionState.GRANTED) {
            call.reject("需要存储权限才能在此 Android 版本保存作品", "PERMISSION_DENIED");
            return;
        }
        saveWithGrantedPermission(call);
    }

    private void saveWithGrantedPermission(PluginCall call) {
        execute(() -> {
            try {
                File source = validatedSource(call.getString("sourceUri", ""));
                String kind = call.getString("kind", "").trim().toLowerCase(Locale.ROOT);
                if (!kind.equals("image") && !kind.equals("video")) {
                    throw new IllegalArgumentException("Unsupported media kind");
                }
                String displayName = sanitizedDisplayName(call.getString("displayName", ""));
                String mimeType = validatedMimeType(call.getString("mimeType", ""), kind);
                SaveResult saved = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? saveScoped(source, displayName, mimeType, kind)
                    : saveLegacy(source, displayName, mimeType, kind);
                call.resolve(resultFor(saved.uri, saved.path, saved.displayName));
            } catch (SecurityException error) {
                call.reject("系统拒绝写入相册，请检查应用权限", "MEDIASTORE_PERMISSION", error);
            } catch (Exception error) {
                call.reject("作品保存失败", "MEDIASTORE_SAVE_FAILED", error);
            }
        });
    }

    private SaveResult saveScoped(File source, String displayName, String mimeType, String kind) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        String topLevel = kind.equals("image") ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_MOVIES;
        Uri collection = kind.equals("image")
            ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            : MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);

        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, displayName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, topLevel + "/" + ALBUM_NAME);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);

        Uri destination = resolver.insert(collection, values);
        if (destination == null) throw new IOException("MediaStore refused the new item");
        try {
            try (InputStream input = new FileInputStream(source);
                 OutputStream output = resolver.openOutputStream(destination, "w")) {
                if (output == null) throw new IOException("Unable to open MediaStore output stream");
                copy(input, output);
            }
            ContentValues ready = new ContentValues();
            ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(destination, ready, null, null);
            String path = topLevel + "/" + ALBUM_NAME + "/" + displayName;
            return new SaveResult(destination.toString(), path, displayName);
        } catch (IOException | RuntimeException error) {
            resolver.delete(destination, null, null);
            throw error;
        }
    }

    @SuppressWarnings("deprecation")
    private SaveResult saveLegacy(File source, String displayName, String mimeType, String kind) throws IOException {
        String topLevel = kind.equals("image") ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_MOVIES;
        File directory = new File(Environment.getExternalStoragePublicDirectory(topLevel), ALBUM_NAME);
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("Unable to create the public media folder");
        }
        File destination = uniqueFile(directory, displayName);
        try (InputStream input = new FileInputStream(source);
             OutputStream output = new FileOutputStream(destination)) {
            copy(input, output);
        }
        MediaScannerConnection.scanFile(
            getContext(),
            new String[] { destination.getAbsolutePath() },
            new String[] { mimeType },
            null
        );
        String path = topLevel + "/" + ALBUM_NAME + "/" + destination.getName();
        return new SaveResult(Uri.fromFile(destination).toString(), path, destination.getName());
    }

    private File validatedSource(String value) throws IOException {
        Uri uri = Uri.parse(value);
        if (!"file".equalsIgnoreCase(uri.getScheme()) || uri.getPath() == null) {
            throw new IllegalArgumentException("Only app-owned temporary files can be published");
        }
        File source = new File(uri.getPath()).getCanonicalFile();
        if (!source.isFile() || !isAppOwned(source)) {
            throw new SecurityException("Source is outside app-controlled storage");
        }
        return source;
    }

    private boolean isAppOwned(File source) throws IOException {
        List<File> roots = new ArrayList<>();
        roots.add(getContext().getCacheDir());
        roots.add(getContext().getFilesDir());
        if (getContext().getExternalCacheDir() != null) roots.add(getContext().getExternalCacheDir());
        File[] externalFiles = getContext().getExternalFilesDirs(null);
        if (externalFiles != null) {
            for (File root : externalFiles) if (root != null) roots.add(root);
        }
        String sourcePath = source.getCanonicalPath();
        for (File root : roots) {
            String rootPath = root.getCanonicalPath();
            if (sourcePath.equals(rootPath) || sourcePath.startsWith(rootPath + File.separator)) return true;
        }
        return false;
    }

    private static String sanitizedDisplayName(String value) {
        String cleaned = value == null ? "" : value
            .replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "-")
            .trim();
        if (cleaned.isEmpty() || cleaned.equals(".") || cleaned.equals("..")) {
            throw new IllegalArgumentException("Invalid display name");
        }
        return cleaned.length() > 96 ? cleaned.substring(cleaned.length() - 96) : cleaned;
    }

    private static String validatedMimeType(String value, String kind) {
        String mimeType = value == null ? "" : value.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        String expectedPrefix = kind + "/";
        if (!mimeType.startsWith(expectedPrefix) || mimeType.length() <= expectedPrefix.length()) {
            throw new IllegalArgumentException("Media MIME type does not match its kind");
        }
        return mimeType;
    }

    private static File uniqueFile(File directory, String displayName) {
        File candidate = new File(directory, displayName);
        if (!candidate.exists()) return candidate;
        int dot = displayName.lastIndexOf('.');
        String stem = dot > 0 ? displayName.substring(0, dot) : displayName;
        String suffix = dot > 0 ? displayName.substring(dot) : "";
        for (int index = 1; index < 10_000; index++) {
            candidate = new File(directory, stem + " (" + index + ")" + suffix);
            if (!candidate.exists()) return candidate;
        }
        throw new IllegalStateException("Unable to allocate a unique media name");
    }

    private static void copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        output.flush();
    }

    private static JSObject resultFor(String uri, String path, String displayName) {
        JSObject result = new JSObject();
        result.put("uri", uri);
        result.put("path", path);
        result.put("displayName", displayName);
        return result;
    }

    private static final class SaveResult {
        final String uri;
        final String path;
        final String displayName;

        SaveResult(String uri, String path, String displayName) {
            this.uri = uri;
            this.path = path;
            this.displayName = displayName;
        }
    }
}
