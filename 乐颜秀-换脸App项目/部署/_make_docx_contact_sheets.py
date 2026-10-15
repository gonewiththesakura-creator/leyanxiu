from pathlib import Path

from PIL import Image, ImageDraw


root = Path(__file__).resolve().parent / "_render_master_20260906_v2"
pages = sorted(root.glob("page-*.png"), key=lambda path: int(path.stem.split("-")[1]))
thumb_width = 780
padding = 24
columns = 2
chunk_size = 4

for start in range(0, len(pages), chunk_size):
    group = pages[start:start + chunk_size]
    thumbs = []
    for page in group:
        image = Image.open(page).convert("RGB")
        height = round(image.height * thumb_width / image.width)
        image = image.resize((thumb_width, height))
        labeled = Image.new("RGB", (thumb_width, height + 36), "white")
        labeled.paste(image, (0, 36))
        ImageDraw.Draw(labeled).text((12, 10), page.name, fill="black")
        thumbs.append(labeled)

    cell_height = max(image.height for image in thumbs)
    rows = (len(thumbs) + columns - 1) // columns
    sheet = Image.new(
        "RGB",
        (columns * thumb_width + (columns + 1) * padding, rows * cell_height + (rows + 1) * padding),
        (210, 214, 220),
    )
    for index, image in enumerate(thumbs):
        x = padding + (index % columns) * (thumb_width + padding)
        y = padding + (index // columns) * (cell_height + padding)
        sheet.paste(image, (x, y))
    sheet.save(root / f"contact-{start // chunk_size + 1}.png")
