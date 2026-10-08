import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isValidSignature } from "../src/webhook.js";

const SECRET = "s3cret";
const BODY = JSON.stringify({ action: "opened" });

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

describe("isValidSignature", () => {
  it("accepts a correct signature", () => {
    expect(isValidSignature(BODY, sign(BODY, SECRET), SECRET)).toBe(true);
  });

  it("accepts a correct signature over a non-ASCII body", () => {
    const body = JSON.stringify({ title: "café \u{1F680}" });
    expect(isValidSignature(body, sign(body, SECRET), SECRET)).toBe(true);
  });

  it("accepts a correct signature over an empty body", () => {
    expect(isValidSignature("", sign("", SECRET), SECRET)).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(isValidSignature(BODY, sign(BODY, "other"), SECRET)).toBe(false);
  });

  it("rejects when the body was tampered with", () => {
    expect(isValidSignature(`${BODY} `, sign(BODY, SECRET), SECRET)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(isValidSignature(BODY, undefined, SECRET)).toBe(false);
  });

  it("rejects an empty header", () => {
    expect(isValidSignature(BODY, "", SECRET)).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const bare = sign(BODY, SECRET).slice("sha256=".length);
    expect(isValidSignature(BODY, bare, SECRET)).toBe(false);
  });

  it("rejects the legacy sha1= scheme", () => {
    expect(isValidSignature(BODY, "sha1=abcdef", SECRET)).toBe(false);
  });

  it("rejects a header of the wrong length without throwing", () => {
    const truncated = sign(BODY, SECRET).slice(0, -2);
    expect(isValidSignature(BODY, truncated, SECRET)).toBe(false);
    expect(isValidSignature(BODY, `${sign(BODY, SECRET)}00`, SECRET)).toBe(false);
    expect(isValidSignature(BODY, "sha256=", SECRET)).toBe(false);
  });

  it("rejects same-length garbage", () => {
    const garbage = `sha256=${"0".repeat(64)}`;
    expect(isValidSignature(BODY, garbage, SECRET)).toBe(false);
  });

  it("is case sensitive on the hex digest", () => {
    const upper = `sha256=${sign(BODY, SECRET).slice("sha256=".length).toUpperCase()}`;
    expect(isValidSignature(BODY, upper, SECRET)).toBe(false);
  });
});
