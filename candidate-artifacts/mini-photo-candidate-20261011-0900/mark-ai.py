import argparse
import json
import os
import re
import struct
import io
import sys
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw, ImageFont, ImageOps, PngImagePlugin

parser = argparse.ArgumentParser()
parser.add_argument("input", nargs="?")
parser.add_argument("output", nargs="?")
parser.add_argument("--check-font", action="store_true")
parser.add_argument("--stdio", action="store_true", help="Bounded PNG bytes via stdin/stdout; no temporary image files")
parser.add_argument("--content-id", default="")
parser.add_argument("--label")
parser.add_argument("--service-provider", default="unconfigured")
parser.add_argument("--operation", choices=("generate", "edit"), default="generate")
args = parser.parse_args()


def label_font(text, size):
    configured = os.environ.get("AI_MARK_FONT", "")
    # An explicitly configured font must work; silently ignoring it would make
    # readiness differ from the operator's intended rendering configuration.
    candidates = [configured] if configured else [
        r"C:\Windows\Fonts\msyh.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ]
    for candidate in candidates:
        if not candidate or not os.path.isfile(candidate):
            continue
        try:
            font = ImageFont.truetype(candidate, size)
            missing = bytes(font.getmask(chr(0x10FFFF)))
            if all(character.isspace() or (
                font.getmask(character).getbbox() is not None
                and bytes(font.getmask(character)) != missing
            ) for character in set(text)):
                return font
        except (OSError, ValueError):
            pass
    raise ValueError("A font with actual glyphs for the visible AI label is required")


if args.check_font:
    label_font("AI生成编辑合成", 18)
    raise SystemExit(0)
if not args.stdio and (not args.input or not args.output):
    parser.error("Input and output image paths are required")
if args.stdio and (args.input or args.output):
    parser.error("Stdio mode does not accept file paths")

# GB 45438-2025 appendix E; the operation is separate provenance, not a new
# Label enum. Both AI generation and AI editing use the definite label "1".
for value in (args.content_id, args.service_provider):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value or "") or value.lower() in ("unconfigured", "unknown", "none"):
        parser.error("A real configured provider code and unique content ID are required")
args.label = args.label if args.label is not None else ("AI编辑" if args.operation == "edit" else "AI生成")
if args.label not in (("AI编辑", "AI生成合成") if args.operation == "edit" else ("AI生成", "AI生成合成")):
    parser.error("An explicit AI label matching the generation/edit operation is required")
output_format = ".png" if args.stdio else os.path.splitext(args.output)[1].lower()
if output_format not in (".png", ".jpg", ".jpeg", ".webp"):
    parser.error("Only PNG, JPEG and WebP image outputs are supported")

if args.stdio:
    source = sys.stdin.buffer.read(20 * 1024 * 1024 + 1)
    if len(source) > 20 * 1024 * 1024 or not source.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Stdio mode requires bounded PNG input")
    image = Image.open(io.BytesIO(source))
    if image.format != "PNG" or getattr(image, "is_animated", False) or max(image.size) > 2048:
        raise ValueError("Stdio mode requires a static PNG of at most 2048 pixels per side")
    # load() may decode a PNG whose IDAT CRC is damaged. Validate the complete
    # container first, then reopen for actual pixel decoding and marking.
    image.verify()
    image = Image.open(io.BytesIO(source))
    destination = io.BytesIO()
else:
    image = Image.open(args.input)
    destination = args.output
image.load()
jpeg_xmp = None
if image.format == "JPEG":
    prefix = b"http://ns.adobe.com/xap/1.0/\x00"
    packets = [data[len(prefix):] for tag, data in image.applist if tag == "APP1" and data.startswith(prefix)]
    if len(packets) > 1:
        raise ValueError("Multiple source XMP packets require review")
    jpeg_xmp = packets[0] if packets else None
# Mark the displayed orientation, not the raw camera sensor layout. Otherwise
# EXIF-rotated portraits would rotate the label sideways in an image viewer.
image = ImageOps.exif_transpose(image)
original_exif = image.getexif()
original_exif.pop(0x0112, None)
original_xmp = image.info.get("xmp") or image.info.get("XML:com.adobe.xmp") or original_exif.get(0x02BC) or jpeg_xmp
original_exif.pop(0x02BC, None)
if image.mode not in ("RGB", "RGBA"):
    image = image.convert("RGBA")

width, height = image.size
if min(width, height) < 128:
    raise ValueError("Image must be at least 128 by 128 pixels for a readable AI label")
font = label_font(args.label, max(18, min(42, width // 28)))

label = f"{args.label} | {args.content_id}" if args.content_id else args.label
draw = ImageDraw.Draw(image, "RGBA")
left, top, right, bottom = draw.textbbox((0, 0), label, font=font)
padding = max(8, width // 120)
# Keep the required label legible on small images; the full content ID is
# always in XMP, so it need not make the visible label run off the canvas.
if right - left + padding * 4 > width:
    label = args.label
    left, top, right, bottom = draw.textbbox((0, 0), label, font=font)
box_w = right - left + padding * 2
box_h = bottom - top + padding * 2
if box_w + padding * 2 > width or box_h + padding * 2 > height:
    raise ValueError("Image cannot contain the readable AI label")
x = max(0, width - box_w - padding)
y = max(0, height - box_h - padding)
draw.rounded_rectangle((x, y, x + box_w, y + box_h), radius=padding, fill=(0, 0, 0, 165), outline=(255, 255, 255, 210), width=1)
draw.text((x + padding - left, y + padding - top), label, fill=(255, 255, 255, 235), font=font)

if not args.stdio:
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)

# TC260's image-file guide: one TC260:AIGC XMP property, updated without
# replacing other properties/namespaces. Keep the historical custom fields
# for old readers, but they are not the standardized implicit identifier.
XMP_NS = "adobe:ns:meta/"
RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
TC260_NS = "http://www.tc260.org.cn/ns/AIGC/1.0"
ET.register_namespace("x", XMP_NS)
ET.register_namespace("rdf", RDF_NS)
ET.register_namespace("TC260", TC260_NS)
if original_xmp:
    xmp_bytes = original_xmp.encode("utf-8") if isinstance(original_xmp, str) else original_xmp
    if len(xmp_bytes) > 60_000:
        raise ValueError("Unsupported or unsafe source XMP")
    # This writer supports UTF-8 XMP only. Byte-regex screening is insufficient:
    # UTF-16/32 NUL-separated DTD declarations otherwise bypass it and Expat
    # expands internal entities. Reject unsupported encodings before parsing.
    xmp_text = xmp_bytes.decode("utf-8-sig", errors="strict")
    encoding = re.search(r"<\?xml\b[^?]*\bencoding\s*=\s*['\"]([^'\"]+)['\"]", xmp_text, re.I)
    if "\x00" in xmp_text or (encoding and encoding.group(1).lower() not in ("utf-8", "utf8")) \
            or re.search(r"<!\s*(DOCTYPE|ENTITY)", xmp_text, re.I):
        raise ValueError("Unsupported or unsafe source XMP")
    root = ET.fromstring(xmp_text)
else:
    root = ET.Element(f"{{{XMP_NS}}}xmpmeta")
rdf = root if root.tag == f"{{{RDF_NS}}}RDF" else root.find(f".//{{{RDF_NS}}}RDF")
if rdf is None:
    rdf = ET.SubElement(root, f"{{{RDF_NS}}}RDF")
descriptions = list(rdf.findall(f"{{{RDF_NS}}}Description"))
if not descriptions:
    descriptions = [ET.SubElement(rdf, f"{{{RDF_NS}}}Description", {f"{{{RDF_NS}}}about": ""})]
for parent in root.iter():
    for name in (f"{{{TC260_NS}}}AIGC", f"{{{TC260_NS}/}}AIGC", "{http://ns.adobe.com/tiff/1.0/}Orientation"):
        parent.attrib.pop(name, None)
        for previous in list(parent):
            if previous.tag == name:
                parent.remove(previous)
aigc = {
    "Label": "1",
    "ContentProducer": args.service_provider,
    "ProduceID": args.content_id,
    "ReservedCode1": "",
    "ContentPropagator": args.service_provider,
    "PropagateID": args.content_id,
    "ReservedCode2": "",
}
ET.SubElement(descriptions[0], f"{{{TC260_NS}}}AIGC").text = json.dumps(aigc, ensure_ascii=True, separators=(",", ":"))
xmp = ET.tostring(root, encoding="utf-8")
if len(xmp) > 60_000:
    raise ValueError("Image XMP is too large")
legacy = f"AI_Generated=true; Service_Provider={args.service_provider}; Content_ID={args.content_id}; AI_Operation={args.operation}"
original_exif[0x9286] = legacy.encode("utf-8")
if output_format == ".png":
    info = PngImagePlugin.PngInfo()
    info.add_text("AI_Generated", "true")
    info.add_text("Service_Provider", args.service_provider)
    info.add_text("Content_ID", args.content_id)
    info.add_text("AI_Operation", args.operation)
    info.add_itxt("XML:com.adobe.xmp", xmp.decode("utf-8"))
    image.save(destination, format="PNG", pnginfo=info)
elif output_format == ".webp":
    image.save(args.output, format="WEBP", exif=original_exif.tobytes(), xmp=xmp, quality=92)
else:
    image.convert("RGB").save(args.output, format="JPEG", exif=original_exif, quality=92)
    # Pillow before 11.1 silently ignores its JPEG xmp argument. Embed the
    # bounded, standard APP1 segment explicitly so the deployed Pillow version
    # cannot claim success while dropping the identifier.
    packet = b"http://ns.adobe.com/xap/1.0/\x00" + xmp
    with open(args.output, "rb") as saved:
        jpeg = saved.read()
    if not jpeg.startswith(b"\xff\xd8"):
        raise ValueError("JPEG encoder produced invalid output")
    with open(args.output, "wb") as saved:
        saved.write(jpeg[:2] + b"\xff\xe1" + struct.pack(">H", len(packet) + 2) + packet + jpeg[2:])

# Confirm that the actual encoder retained the standard payload. A installed
# Pillow/libwebp build that drops XMP must not be reported as a marked output.
if args.stdio:
    if destination.tell() > 20 * 1024 * 1024:
        raise ValueError("Marked PNG exceeds output bound")
    destination.seek(0)
with Image.open(destination) as saved:
    embedded = saved.info.get("xmp") or saved.info.get("XML:com.adobe.xmp")
    if not embedded and saved.format == "JPEG":
        prefix = b"http://ns.adobe.com/xap/1.0/\x00"
        embedded = next((data[len(prefix):] for tag, data in saved.applist if tag == "APP1" and data.startswith(prefix)), None)
    if not embedded:
        raise ValueError("Encoded image lost its AIGC metadata")
    identified = ET.fromstring(embedded).findall(f".//{{{TC260_NS}}}AIGC")
    if len(identified) != 1 or json.loads(identified[0].text) != aigc:
        raise ValueError("Encoded image AIGC metadata does not match the content")
if args.stdio:
    sys.stdout.buffer.write(destination.getvalue())
