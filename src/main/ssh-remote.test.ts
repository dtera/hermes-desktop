import { describe, expect, it } from "vitest";
import {
  buildGatewayStartCommand,
  buildGatewayStatusCommand,
  buildGatewayStopCommand,
} from "./ssh-remote";

describe("SSH remote profile gateway commands", () => {
  it("uses the default systemd-aware gateway command for the default profile", () => {
    const command = buildGatewayStartCommand();

    expect(command).toContain("systemctl start hermes.service");
    expect(command).toContain("hermes gateway start");
    expect(command).not.toContain("--profile");
  });

  it("targets the named profile gateway pid and CLI flag", () => {
    const start = buildGatewayStartCommand("research");
    const status = buildGatewayStatusCommand("research");
    const stop = buildGatewayStopCommand("research");

    expect(start).toContain("$HOME/.hermes/profiles/research");
    expect(start).toContain("--profile");
    expect(start).toContain("research");
    expect(status).toContain("$HOME/.hermes/profiles/research/gateway.pid");
    expect(stop).toContain("$HOME/.hermes/profiles/research/gateway.pid");
  });
});
