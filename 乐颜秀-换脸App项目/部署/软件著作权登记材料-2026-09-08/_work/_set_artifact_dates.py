from __future__ import annotations

import hashlib
import os
import zipfile
from datetime import datetime
from pathlib import Path

from docx import Document
from pypdf import PdfReader, PdfWriter


ROOT = Path(r"D:\Documents\kimi\workspace\乐颜秀-换脸App项目\部署\软件著作权登记材料-2026-09-08")
WORK = ROOT / "_work"
TARGET = datetime(2026, 9, 9, 18, 18, 0)
PDF_DATE = "D:20260909181800+08'00'"

SOURCE_PDF = ROOT / "乐颜秀AI影像创作软件V1.0-源程序鉴别材料.pdf"
MANUAL_PDF = ROOT / "乐颜秀AI影像创作软件V1.0-用户操作说明书.pdf"
FILL_TXT = ROOT / "R11软件著作权登记填报内容-直接粘贴.txt"
INVENTORY_CSV = ROOT / "源程序文件清单与行数统计.csv"
PACKAGE_NOTE = ROOT / "材料包使用说明.txt"
HASHES_TXT = ROOT / "SHA256校验值.txt"
ZIP_PATH = ROOT / "乐颜秀软件著作权登记申请材料包-2026-09-08.zip"

PAYLOAD_FILES = [SOURCE_PDF, MANUAL_PDF, FILL_TXT, INVENTORY_CSV, PACKAGE_NOTE]
ZIP_FILES = [*PAYLOAD_FILES, HASHES_TXT]


def set_pdf_dates(path: Path) -> None:
    reader = PdfReader(str(path))
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    metadata = {
        str(key): str(value)
        for key, value in (reader.metadata or {}).items()
        if key and value is not None
    }
    metadata["/CreationDate"] = PDF_DATE
    metadata["/ModDate"] = PDF_DATE
    writer.add_metadata(metadata)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("wb") as stream:
        writer.write(stream)
    os.replace(temp, path)


def set_docx_dates(path: Path) -> None:
    document = Document(path)
    document.core_properties.created = TARGET
    document.core_properties.modified = TARGET
    document.save(path)


def update_hash_manifest() -> None:
    lines = ["SHA-256  文件名"]
    for path in PAYLOAD_FILES:
        digest = hashlib.sha256(path.read_bytes()).hexdigest().upper()
        lines.append(f"{digest}  {path.name}")
    HASHES_TXT.write_text("\n".join(lines) + "\n", encoding="utf-8-sig")


def rebuild_zip() -> None:
    temp = ZIP_PATH.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in ZIP_FILES:
            info = zipfile.ZipInfo(path.name, TARGET.timetuple()[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    os.replace(temp, ZIP_PATH)


def main() -> None:
    for path in (SOURCE_PDF, MANUAL_PDF):
        set_pdf_dates(path)
    for path in WORK.glob("*.docx"):
        set_docx_dates(path)
    update_hash_manifest()
    rebuild_zip()
    print(f"updated_pdfs=2 updated_docx={len(list(WORK.glob('*.docx')))} zip_entries={len(ZIP_FILES)}")


if __name__ == "__main__":
    main()
