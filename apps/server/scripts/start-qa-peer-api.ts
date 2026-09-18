// Dedicated local peer for cross-instance QA. Never replaces the primary API.
process.env.LOOMIC_SERVER_PORT = "3003";
process.env.HOST = "127.0.0.1";
await import("../src/server.js");
