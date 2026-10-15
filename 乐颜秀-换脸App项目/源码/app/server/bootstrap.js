import "./env.js";
import { adminSnapshot } from "./admin-snapshot.js";

// Keep the executable entry point explicit for npm start/dev while index.js
// remains directly runnable for tests and operational diagnostics.
await adminSnapshot()?.restore();
await import("./index.js");
