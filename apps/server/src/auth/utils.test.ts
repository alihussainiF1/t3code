import { describe, expect, it } from "vite-plus/test";

import {
  deriveAuthClientMetadata,
  isRemoteReachableHost,
  isTrustedRequestOrigin,
  resolveSessionCookieName,
} from "./utils.ts";

describe("isTrustedRequestOrigin", () => {
  const isTrusted = (headers: Record<string, string>, devUrl?: URL) =>
    isTrustedRequestOrigin({ headers } as never, {
      allowedOrigins: [],
      devUrl,
    });

  it("accepts the server's own origin, including default ports and case", () => {
    expect(isTrusted({ host: "box.example.com", origin: "https://Box.Example.com" })).toBe(true);
    expect(isTrusted({ host: "box.example.com:443", origin: "https://box.example.com" })).toBe(
      true,
    );
    expect(isTrusted({ host: "[::1]:3773", origin: "http://[::1]:3773" })).toBe(true);
    expect(isTrusted({ host: "127.0.0.1:3773" })).toBe(true);
  });

  it("rejects other ports, opaque origins, and non-web schemes", () => {
    expect(isTrusted({ host: "127.0.0.1:3773", origin: "http://127.0.0.1:5173" })).toBe(false);
    expect(isTrusted({ host: "127.0.0.1:3773", origin: "http://localhost:3773" })).toBe(false);
    expect(isTrusted({ host: "127.0.0.1:3773", origin: "null" })).toBe(false);
    expect(isTrusted({ host: "app", origin: "t3code://app" })).toBe(false);
  });

  it("accepts the proxy's public authority and, in dev, the Vite port", () => {
    expect(
      isTrusted({
        host: "127.0.0.1:3773",
        "x-forwarded-host": "box.tail1234.ts.net",
        origin: "https://box.tail1234.ts.net",
      }),
    ).toBe(true);
    const devUrl = new URL("http://localhost:5733");
    expect(isTrusted({ host: "127.0.0.1:3773", origin: "http://192.168.1.4:5733" }, devUrl)).toBe(
      true,
    );
    expect(isTrusted({ host: "127.0.0.1:3773", origin: "http://127.0.0.1:5173" }, devUrl)).toBe(
      false,
    );
  });
});

describe("deriveAuthClientMetadata", () => {
  it("labels Electron user agents as Electron instead of Chrome", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) t3code/0.0.15 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        source: {
          remoteAddress: "::ffff:127.0.0.1",
        },
      } as never,
    });

    expect(metadata).toMatchObject({
      browser: "Electron",
      deviceType: "desktop",
      ipAddress: "127.0.0.1",
      os: "macOS",
    });
  });

  it("applies client-presented display identity without replacing transport metadata", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        source: {
          remoteAddress: "::ffff:192.168.213.72",
        },
      } as never,
      presented: {
        label: "T3 Code Mobile",
        deviceType: "mobile",
        os: "iOS",
      },
    });

    expect(metadata).toMatchObject({
      label: "T3 Code Mobile",
      browser: "Electron",
      deviceType: "mobile",
      ipAddress: "192.168.213.72",
      os: "iOS",
    });
    expect(metadata.userAgent).toContain("Electron/36.3.2");
  });
});

describe("session cookie isolation", () => {
  it("isolates loopback web servers by port and server state", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: "/tmp/t3-agent-one",
      environmentId: "environment-one",
      development: true,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: "/tmp/t3-agent-two",
      environmentId: "environment-two",
      development: true,
    });

    expect(first).toMatch(/^t3_session_5775_[a-f0-9]{12}$/);
    expect(second).toMatch(/^t3_session_5775_[a-f0-9]{12}$/);
    expect(first).not.toBe(second);
  });

  it("isolates remote web servers by server state", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 3773,
      host: "192.168.1.50",
      instanceKey: "/srv/t3-one",
      environmentId: "environment-one",
      development: false,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "192.168.1.50",
      instanceKey: "/srv/t3-two",
      environmentId: "environment-two",
      development: false,
    });

    expect(first).toMatch(/^t3_session_[a-f0-9]{12}$/);
    expect(second).toMatch(/^t3_session_[a-f0-9]{12}$/);
    expect(first).not.toBe(second);
  });

  it("keeps a remote web server cookie stable across port changes", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 8080,
      host: "0.0.0.0",
      instanceKey: "/srv/t3",
      environmentId: "environment-one",
      development: false,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 9090,
      host: "app.example.com",
      instanceKey: "/srv/t3",
      environmentId: "environment-one",
      development: false,
    });

    expect(first).toBe(second);
  });

  it("retains desktop port scoping", () => {
    expect(
      resolveSessionCookieName({
        mode: "desktop",
        port: 3773,
        host: "127.0.0.1",
        instanceKey: "/tmp/desktop",
        environmentId: "environment-one",
        development: true,
      }),
    ).toBe("t3_session_3773");
  });

  it("isolates development servers even when they bind a wildcard host", () => {
    expect(
      resolveSessionCookieName({
        mode: "web",
        port: 5775,
        host: "0.0.0.0",
        instanceKey: "/tmp/t3-wildcard-dev",
        environmentId: "environment-one",
        development: true,
      }),
    ).toMatch(/^t3_session_5775_[a-f0-9]{12}$/);
  });

  it("classifies loopback aliases separately from remotely reachable hosts", () => {
    expect(isRemoteReachableHost(undefined)).toBe(false);
    expect(isRemoteReachableHost("localhost")).toBe(false);
    expect(isRemoteReachableHost("127.12.0.1")).toBe(false);
    expect(isRemoteReachableHost("[::1]")).toBe(false);
    expect(isRemoteReachableHost("0.0.0.0")).toBe(true);
    expect(isRemoteReachableHost("192.168.1.50")).toBe(true);
  });
});
