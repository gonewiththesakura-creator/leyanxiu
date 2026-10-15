from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(r"D:\Documents\kimi\workspace\乐颜秀-换脸App项目\部署\软件著作权登记材料-2026-09-08")


def make(render_dir: Path, prefix: str, chunk_size: int, columns: int, thumb_width: int) -> None:
    pages = sorted(render_dir.glob("page-*.png"), key=lambda path: int(path.stem.split("-")[1]))
    padding = 20
    for start in range(0, len(pages), chunk_size):
        group = pages[start:start + chunk_size]
        thumbs = []
        for page in group:
            image = Image.open(page).convert("RGB")
            height = round(image.height * thumb_width / image.width)
            image = image.resize((thumb_width, height), Image.Resampling.LANCZOS)
            labeled = Image.new("RGB", (thumb_width, height + 34), "white")
            labeled.paste(image, (0, 34))
            ImageDraw.Draw(labeled).text((10, 9), page.name, fill="black")
            thumbs.append(labeled)
        cell_height = max(image.height for image in thumbs)
        rows = (len(thumbs) + columns - 1) // columns
        sheet = Image.new(
            "RGB",
            (columns * thumb_width + (columns + 1) * padding, rows * cell_height + (rows + 1) * padding),
            (220, 223, 227),
        )
        for index, image in enumerate(thumbs):
            x = padding + (index % columns) * (thumb_width + padding)
            y = padding + (index // columns) * (cell_height + padding)
            sheet.paste(image, (x, y))
        sheet.save(render_dir / f"{prefix}-contact-{start // chunk_size + 1:02d}.jpg", quality=88)


make(ROOT / "_render_manual_pdf_v2", "manual", chunk_size=4, columns=2, thumb_width=620)
make(ROOT / "_render_source_pdf", "source", chunk_size=6, columns=2, thumb_width=520)
