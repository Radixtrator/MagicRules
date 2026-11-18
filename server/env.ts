// Loaded first by server.ts so other modules see the environment at import time.
import dotenv from "dotenv";

dotenv.config({ path: [".env.local", ".env"], quiet: true });
