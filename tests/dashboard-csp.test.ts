import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const mainSrc = readFileSync(join(ROOT, "src/main/index.ts"), "utf-8");
const rendererIndexHtml = readFileSync(
  join(ROOT, "src/renderer/index.html"),
  "utf-8",
);

const loopbackConnectSources = [
  "http://127.0.0.1:*",
  "http://localhost:*",
  "ws://127.0.0.1:*",
  "ws://localhost:*",
];

describe("dashboard Content Security Policy", () => {
  it("allows loopback HTTP and WebSocket connections in the production CSP header", () => {
    for (const source of loopbackConnectSources) {
      expect(mainSrc).toContain(source);
    }
  });

  it("keeps the renderer meta CSP aligned with the production loopback sources", () => {
    for (const source of loopbackConnectSources) {
      expect(rendererIndexHtml).toContain(source);
    }
  });
});
