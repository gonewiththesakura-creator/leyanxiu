// Local only. compressImage creates WeChat temporary files; never save, upload,
// log or persist the selected photo. Dimension options require base library 2.26.0.
const inputLimit = 20 * 1024 * 1024;
const outputLimit = 2 * 1024 * 1024;
const minimumSide = 256;
const mimeTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function localPath(value) {
  // DevTools exposes local temporary images under http://tmp/.
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)
    || !((value.startsWith('/') && !value.startsWith('//')) || /^wxfile:\/\//.test(value) || /^https?:\/\/tmp\//.test(value))) {
    throw new Error('请选择本机相册或相机中的照片。');
  }
  return value;
}
function bytes(value, limit) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > limit) throw new Error(limit === inputLimit
    ? '请使用不超过 20MB 的照片。' : '照片处理后仍超过 2MB，请换一张照片。');
  return value;
}
function imageInfo(info) {
  const type = String(info?.type).toLowerCase();
  const mime = Object.prototype.hasOwnProperty.call(mimeTypes, type) ? mimeTypes[type] : '';
  if (!mime || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height)
    || Math.min(info.width, info.height) < minimumSide || !Number.isSafeInteger(info.width * info.height)) {
    throw new Error('请选择宽高均不少于 256 像素的 JPG、PNG 或 WebP 照片。');
  }
  return { width: info.width, height: info.height, mime };
}
function dimensionsFit(info) { return info.width <= 8192 && info.height <= 8192 && info.width * info.height <= 40000000; }
function targetSize(info, longest) {
  const scale = Math.min(1, longest / Math.max(info.width, info.height));
  const width = Math.floor(info.width * scale), height = Math.floor(info.height * scale);
  if (Math.min(width, height) < minimumSide) throw new Error('照片比例过长，请裁剪后重新选择，宽高均不少于 256 像素。');
  return { compressedWidth: width, compressedHeight: height };
}
function base64Bytes(value) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(outputLimit / 3) * 4
    || value.length % 4 || /[^A-Za-z0-9+/=]/.test(value)) throw new Error('照片读取不完整，请重新选择。');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.indexOf('=') !== (padding ? value.length - padding : -1)) throw new Error('照片读取不完整，请重新选择。');
  return bytes(value.length / 4 * 3 - padding, outputLimit);
}

async function prepareLocalPhoto(wxApi, selected, { isCurrent = () => true } = {}) {
  const check = () => { if (!isCurrent()) { const error = new Error('本次照片操作已取消。'); error.errMsg = 'photo:cancel'; throw error; } };
  const invoke = async (owner, method, options) => {
    check();
    if (typeof owner?.[method] !== 'function') throw new Error('当前微信暂不支持照片处理，请更新微信后重试。');
    const result = await new Promise((resolve, reject) => owner[method]({ ...options, success: resolve, fail: reject }));
    check(); return result;
  };
  check();
  const originalPath = localPath(selected?.tempFilePath);
  bytes(selected?.size, inputLimit);
  const fs = wxApi.getFileSystemManager();
  const inspect = async path => {
    const size = (await invoke(fs, 'getFileInfo', { filePath: path })).size;
    bytes(size, inputLimit);
    const info = imageInfo(await invoke(wxApi, 'getImageInfo', { src: path }));
    return { ...info, size };
  };
  const original = await inspect(originalPath);
  let path = originalPath, info = original, compressionAttempts = 0;
  if (info.size > outputLimit || !dimensionsFit(info)) {
    // Always start from the selected original; do not repeatedly recompress a
    // lossy intermediate. PNG may ignore quality: measured output decides.
    for (const longest of [2000, 1600]) {
      const minimumLongest = Math.ceil(minimumSide * Math.max(original.width, original.height) / Math.min(original.width, original.height)) + 1;
      const target = targetSize(original, longest === 1600 ? Math.min(2000, Math.max(longest, minimumLongest)) : longest);
      const result = await invoke(wxApi, 'compressImage', { src: originalPath, quality: compressionAttempts ? 65 : 85, ...target });
      compressionAttempts++;
      path = localPath(result?.tempFilePath);
      if (path === originalPath) throw new Error('照片未能完成本地处理，请换一张照片。');
      info = await inspect(path);
      if (info.size <= outputLimit && dimensionsFit(info) && Math.max(info.width, info.height) <= 2000) break;
    }
    if (Math.max(info.width, info.height) > 2000) throw new Error('照片尺寸未能缩小，请更新微信或换一张照片。');
  }
  bytes(info.size, outputLimit);
  if (!dimensionsFit(info)) throw new Error('照片尺寸超过限制，请换一张照片。');
  const result = await invoke(fs, 'readFile', { filePath: path, encoding: 'base64' });
  if (base64Bytes(result?.data) !== info.size) throw new Error('照片读取不完整，请重新选择。');
  // Recheck the file after reading as well; picker/compressor metadata alone
  // cannot establish the actual payload length.
  const finalSize = (await invoke(fs, 'getFileInfo', { filePath: path })).size;
  if (bytes(finalSize, outputLimit) !== info.size) throw new Error('照片已变化，请重新选择。');
  check();
  return { path, dataUrl: `data:${info.mime};base64,${result.data}`, width: info.width, height: info.height,
    bytes: info.size, compressionAttempts };
}

module.exports = { prepareLocalPhoto, inputLimit, outputLimit };
