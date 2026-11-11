import { SignJWT, jwtVerify } from "jose";
import { config } from "./config.ts";

const secret = new TextEncoder().encode(config.jwtSecret);

export type AccessClaims = {
  sub: string;
  deviceId: string;
  plan: "free" | "paid";
};

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ deviceId: claims.deviceId, plan: claims.plan })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTtlSec}s`)
    .sign(secret);
}

export async function verifyAccessToken(
  token: string,
): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    const sub = payload.sub;
    const deviceId = payload.deviceId;
    const plan = payload.plan;
    if (typeof sub !== "string" || typeof deviceId !== "string") return null;
    return {
      sub,
      deviceId,
      plan: plan === "paid" ? "paid" : "free",
    };
  } catch {
    return null;
  }
}

/** refresh token 是高熵随机串，只存哈希在库里 */
export function newOpaqueToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 6 位数字验证码 */
export function newLoginCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const value =
    ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  return String(value % 1_000_000).padStart(6, "0");
}
