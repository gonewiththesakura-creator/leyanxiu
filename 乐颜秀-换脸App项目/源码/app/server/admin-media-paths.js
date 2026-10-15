import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ADMIN_ASSET_ROOT = path.resolve(process.env.ADMIN_ASSET_DIR || path.join(process.env.ADMIN_DATA_DIR || path.join(here, "data"), "admin-assets"));
export const ADMIN_MEDIA_PREFIX = "/effects/uploads/";
export const ADMIN_MEDIA_DIR = path.join(ADMIN_ASSET_ROOT, "effects", "uploads");
