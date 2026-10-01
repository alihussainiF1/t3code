import { assert, describe, it } from "@effect/vitest";

import { resolveReusableRuntimeServer } from "./runtimeReuse.ts";

const base = { version: 1, pid: 4242, port: 3773, origin: "http://127.0.0.1:3773" };

describe("resolveReusableRuntimeServer", () => {
  it("reuses a server bound to loopback", () => {
    assert.deepEqual(resolveReusableRuntimeServer({ ...base, host: "127.0.0.1" }), {
      pid: 4242,
      port: 3773,
    });
    assert.deepEqual(resolveReusableRuntimeServer({ ...base, host: "::1" }), {
      pid: 4242,
      port: 3773,
    });
    assert.deepEqual(resolveReusableRuntimeServer({ ...base, host: "localhost" }), {
      pid: 4242,
      port: 3773,
    });
  });

  it("refuses a server bound to all interfaces even though its origin is loopback", () => {
    assert.isNull(resolveReusableRuntimeServer({ ...base, host: "0.0.0.0" }));
    assert.isNull(resolveReusableRuntimeServer({ ...base, host: "::" }));
    assert.isNull(resolveReusableRuntimeServer({ ...base, host: "[::]" }));
  });

  it("refuses a server bound to a specific non-loopback interface", () => {
    assert.isNull(resolveReusableRuntimeServer({ ...base, host: "100.64.0.7" }));
    assert.isNull(
      resolveReusableRuntimeServer({
        ...base,
        host: "192.168.1.20",
        origin: "http://192.168.1.20:3773",
      }),
    );
    assert.isNull(resolveReusableRuntimeServer({ ...base, host: 7 }));
  });

  it("falls back to the loopback origin check for runtime files without a host", () => {
    assert.deepEqual(resolveReusableRuntimeServer(base), { pid: 4242, port: 3773 });
    assert.isNull(resolveReusableRuntimeServer({ ...base, origin: "http://10.0.0.5:3773" }));
    assert.isNull(resolveReusableRuntimeServer({ ...base, origin: "https://127.0.0.1:3773" }));
    assert.isNull(resolveReusableRuntimeServer({ ...base, origin: "not a url" }));
  });

  it("rejects malformed runtime state", () => {
    assert.isNull(resolveReusableRuntimeServer(null));
    assert.isNull(resolveReusableRuntimeServer("runtime"));
    assert.isNull(resolveReusableRuntimeServer({ ...base, pid: 0 }));
    assert.isNull(resolveReusableRuntimeServer({ ...base, port: "abc" }));
  });
});
