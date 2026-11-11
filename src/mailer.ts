import nodemailer from "nodemailer";
import { config } from "./config.ts";

/**
 * 发信通道。
 *
 * 现在用 QQ 邮箱 SMTP（授权码），适合内测；
 * 用户过百就换成 SES / Resend，只需要替换 createTransport 这一段。
 */

const transport = nodemailer.createTransport({
  host: config.mail.host,
  port: config.mail.port,
  secure: config.mail.port === 465,
  auth: { user: config.mail.user, pass: config.mail.pass },
});

export async function sendLoginCode(email: string, code: string): Promise<void> {
  const text = [
    `你的 WayMuse 登录验证码是：${code}`,
    "",
    "10 分钟内有效。如果不是你本人操作，忽略这封邮件即可。",
  ].join("\n");

  await transport.sendMail({
    from: `WayMuse <${config.mail.from}>`,
    to: email,
    subject: `WayMuse 登录验证码 ${code}`,
    text,
    // 纯文本为主：更不容易进垃圾箱，也不会被当成营销邮件
  });
}

export async function verifyMailer(): Promise<boolean> {
  if (!config.mail.user || !config.mail.pass) return false;
  try {
    await transport.verify();
    return true;
  } catch {
    return false;
  }
}
