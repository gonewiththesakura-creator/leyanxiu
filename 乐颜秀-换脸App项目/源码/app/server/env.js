import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load the server-local env file regardless of the caller's working directory.
// dotenv's default `override: false` keeps values supplied by the host/runtime.
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.DOTENV_CONFIG_PATH || path.join(serverDir, ".env");
dotenv.config({ path: envFile, override: false });

export { envFile };
