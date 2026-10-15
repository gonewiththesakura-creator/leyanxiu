"""Bounded, in-memory input normalization; no original metadata is forwarded."""
import io
import sys
import warnings

from PIL import Image, ImageCms, ImageFile, ImageOps, PngImagePlugin

MAX_BYTES = 2 * 1024 * 1024
MAX_SIDE = 8192
MAX_PIXELS = 40_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
ImageFile.LOAD_TRUNCATED_IMAGES = False
PngImagePlugin.MAX_TEXT_CHUNK = 64 * 1024
PngImagePlugin.MAX_TEXT_MEMORY = 128 * 1024
warnings.simplefilter("error", Image.DecompressionBombWarning)


class InvalidImage(Exception):
    pass


class BoundedOutput(io.BytesIO):
    def write(self, data):
        if self.tell() + len(data) > MAX_BYTES:
            raise InvalidImage()
        return super().write(data)


def inspect(image):
    width, height = image.size
    if (image.format not in ("JPEG", "PNG", "WEBP")
            or not 0 < width <= MAX_SIDE or not 0 < height <= MAX_SIDE
            or width * height > MAX_PIXELS or getattr(image, "n_frames", 1) != 1):
        raise InvalidImage()


def normalize(data):
    if not 16 <= len(data) <= MAX_BYTES:
        raise InvalidImage()
    # Verify container integrity before loading pixel data. Reopen after verify.
    with Image.open(io.BytesIO(data)) as checked:
        inspect(checked)
        checked.verify()
    with Image.open(io.BytesIO(data)) as original:
        inspect(original)
        original.load()
        source_format = original.format
        # Consume Orientation while it is still available, before discarding it.
        image = ImageOps.exif_transpose(original)
    try:
        if image.mode not in ("RGB", "RGBA", "L", "LA", "P", "CMYK"):
            raise InvalidImage()
        alpha = image.convert("RGBA").getchannel("A") if "A" in image.getbands() or "transparency" in image.info else None
        profile = image.info.get("icc_profile")
        if profile is not None:
            if not isinstance(profile, bytes) or not 0 < len(profile) <= 128 * 1024:
                raise InvalidImage()
            base = image if image.mode in ("RGB", "L", "CMYK") else image.convert("RGB")
            # Convert tagged colors; retaining the original profile could leak
            # camera/profile descriptions. Malformed/unsupported profiles reject.
            pixels = ImageCms.profileToProfile(base, ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                                               ImageCms.createProfile("sRGB"), outputMode="RGB")
        else:
            # Untagged RGB/gray is treated as sRGB. Do not guess untagged CMYK
            # or discard a non-sRGB PNG gamma/chromaticity declaration silently.
            if image.mode == "CMYK":
                raise InvalidImage()
            if "srgb" not in image.info:
                gamma = image.info.get("gamma")
                chromaticity = image.info.get("chromaticity")
                srgb_chromaticity = (0.3127, 0.3290, 0.6400, 0.3300, 0.3000, 0.6000, 0.1500, 0.0600)
                if gamma is not None and abs(gamma - 0.45455) > 0.0001:
                    raise InvalidImage()
                if chromaticity is not None and (len(chromaticity) != 8 or any(
                        abs(a - b) > 0.0001 for a, b in zip(chromaticity, srgb_chromaticity))):
                    raise InvalidImage()
            pixels = image.convert("RGB")
        if alpha is not None:
            pixels.putalpha(alpha)
        # A fresh pixel-only image prevents EXIF/GPS/XMP/IPTC/comments, embedded
        # thumbnails, original ICC and arbitrary decoder info from being copied.
        clean = Image.new(pixels.mode, pixels.size)
        clean.paste(pixels)
        output = BoundedOutput()
        if source_format == "JPEG" and alpha is None:
            clean.save(output, format="JPEG", quality=95, subsampling=0, optimize=False, progressive=False)
        else:
            # PNG preserves transparency, including palette tRNS, and decoded
            # WebP pixels without another lossy encoding or invented background.
            clean.save(output, format="PNG", optimize=False, compress_level=6)
        return output.getvalue()
    finally:
        image.close()


def main():
    # Linux container guard complements byte/pixel limits and the parent's
    # wall-clock deadline. Windows offline tests retain all other bounds.
    if sys.platform != "win32":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
    if sys.argv[1:] == ["--check"]:
        fixture = io.BytesIO()
        Image.new("RGBA", (2, 3), (10, 20, 30, 40)).save(fixture, format="PNG")
        result = normalize(fixture.getvalue())
        with Image.open(io.BytesIO(result)) as image:
            if image.size != (2, 3) or image.getpixel((0, 0)) != (10, 20, 30, 40) or image.info:
                raise InvalidImage()
        return
    if sys.argv[1:] != ["--stdio"]:
        raise InvalidImage()
    result = normalize(sys.stdin.buffer.read(MAX_BYTES + 1))
    sys.stdout.buffer.write(result)


if __name__ == "__main__":
    try:
        main()
    except (InvalidImage, OSError, ValueError, SyntaxError, Image.DecompressionBombError,
            Image.DecompressionBombWarning, ImageCms.PyCMSError):
        # No metadata, file names or decoder diagnostics enter application logs.
        sys.exit(2)
    except Exception:
        sys.exit(1)
