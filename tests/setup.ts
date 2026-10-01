import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sqlite = require(["node", "sqlite"].join(":"));

(globalThis as unknown as { __DECAY_SQLITE__: unknown }).__DECAY_SQLITE__ = sqlite;
