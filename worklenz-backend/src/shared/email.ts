import {SendEmailCommand, SESClient} from "@aws-sdk/client-ses";
import nodemailer from "nodemailer";
import {Validator} from "jsonschema";
import {QueryResult} from "pg";
import {log_error, isValidateEmail} from "./utils";
import emailRequestSchema from "../json_schemas/email-request-schema";
import db from "../config/db";

const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || "ses"; // "ses" or "smtp"
const EMAIL_SENDER = process.env.EMAIL_SENDER || "Worklenz <noreply@worklenz.com>";

// AWS SES client
const sesClient = new SESClient({region: process.env.AWS_REGION});

// Nodemailer SMTP transporter (created lazily)
let smtpTransporter: nodemailer.Transporter | null = null;

function getSmtpTransporter(): nodemailer.Transporter {
  if (!smtpTransporter) {
    smtpTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true", // true for 465, false for 587
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });
  }
  return smtpTransporter;
}

export interface IEmail {
  to?: string[];
  subject: string;
  html: string;
}

export class EmailRequest implements IEmail {
  public readonly html: string;
  public readonly subject: string;
  public readonly to: string[];

  constructor(toEmails: string[], subject: string, content: string) {
    this.to = toEmails;
    this.subject = subject;
    this.html = content;
  }
}

function isValidMailBody(body: IEmail) {
  const validator = new Validator();
  return validator.validate(body, emailRequestSchema).valid;
}

async function removeMails(query: string, emails: string[]) {
  const result: QueryResult<{ email: string; }> = await db.query(query, []);
  const bouncedEmails = result.rows.map(e => e.email);
  for (let i = emails.length - 1; i >= 0; i--) {
    const email = emails[i];
    if (bouncedEmails.includes(email)) {
      emails.splice(i, 1);
    }
  }
}

async function filterSpamEmails(emails: string[]): Promise<void> {
  await removeMails("SELECT email FROM spam_emails ORDER BY email;", emails);
}

async function filterBouncedEmails(emails: string[]): Promise<void> {
  await removeMails("SELECT email FROM bounced_emails ORDER BY email;", emails);
}

async function sendViaSes(email: IEmail): Promise<string | null> {
  const charset = "UTF-8";
  const command = new SendEmailCommand({
    Destination: {
      ToAddresses: email.to
    },
    Message: {
      Subject: {Charset: charset, Data: email.subject},
      Body: {Html: {Charset: charset, Data: email.html}}
    },
    Source: EMAIL_SENDER
  });
  const res = await sesClient.send(command);
  return res.MessageId || null;
}

async function sendViaSmtp(email: IEmail): Promise<string | null> {
  const transporter = getSmtpTransporter();
  const info = await transporter.sendMail({
    from: EMAIL_SENDER,
    to: email.to?.join(", "),
    subject: email.subject,
    html: email.html,
  });
  return info.messageId || null;
}

export async function sendEmail(email: IEmail): Promise<string | null> {
  try {
    const options = {...email} as IEmail;
    options.to = Array.isArray(options.to) ? Array.from(new Set(options.to)) : [];

    // Filter out empty, null, undefined, and invalid emails
    options.to = options.to
      .filter(email => email && typeof email === 'string' && email.trim().length > 0)
      .map(email => email.trim())
      .filter(email => isValidateEmail(email));

    if (options.to.length) {
      await filterBouncedEmails(options.to);
      await filterSpamEmails(options.to);
    }

    if (!options.to.length) return null;
    if (!isValidMailBody(options)) return null;

    if (EMAIL_PROVIDER === "smtp") {
      return await sendViaSmtp(options);
    }
    return await sendViaSes(options);
  } catch (e) {
    log_error(e);
  }

  return null;
}
