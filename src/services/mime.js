import { randomBytes } from 'node:crypto';

const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export class MimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MimeError';
    this.status = 400;
  }
}

export function encodeHeader(value) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (!/[^\x20-\x7E]/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

export function textToHtml(text) {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

function base64Lines(buffer) {
  const encoded = buffer.toString('base64');
  const lines = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return lines.join('\r\n');
}

function addressLine(value) {
  const text = String(value || '').replace(/[\r\n]/g, ' ').trim();
  const match = text.match(/^(.*?)\s*<([^>]+)>$/);
  if (!match) return text;
  const name = match[1].trim();
  return name ? `${encodeHeader(name)} <${match[2].trim()}>` : match[2].trim();
}

export function buildMime({
  from, to = [], cc = [], bcc = [], subject = '', text = '', html = '',
  inReplyTo = '', references = '', attachments = []
}) {
  const boundary = `umail_${randomBytes(12).toString('hex')}`;
  const altBoundary = `${boundary}_alt`;
  const domain = String(from).split('@')[1] || 'umail.local';
  const messageId = `<${randomBytes(16).toString('hex')}@${domain}>`;

  const clean = (value) => String(value || '').replace(/[\r\n]+/g, ' ').trim();
  const headers = [
    `From: ${addressLine(from)}`,
    ...(to.length ? [`To: ${to.map(addressLine).join(', ')}`] : []),
    ...(cc.length ? [`Cc: ${cc.map(addressLine).join(', ')}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.map(addressLine).join(', ')}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    ...(inReplyTo ? [`In-Reply-To: ${clean(inReplyTo)}`] : []),
    ...(references ? [`References: ${clean(references)}`] : [])
  ];

  const alternative = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(text, 'utf8')),
    `--${altBoundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(html || textToHtml(text), 'utf8')),
    `--${altBoundary}--`
  ].join('\r\n');

  let body;
  if (attachments.length) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [
      `--${boundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      alternative
    ];
    for (const attachment of attachments) {
      const name = String(attachment.name || 'attachment').replace(/[\r\n"]/g, '').slice(0, 180);
      const ascii = /^[\x20-\x7E]*$/.test(name);
      const encoded = ascii ? `"${name}"` : `UTF-8''${encodeURIComponent(name)}`;
      const nameKey = ascii ? 'name' : 'name*';
      const fileKey = ascii ? 'filename' : 'filename*';
      parts.push(
        `--${boundary}`,
        `Content-Type: ${attachment.type || 'application/octet-stream'}; ${nameKey}=${encoded}`,
        `Content-Disposition: attachment; ${fileKey}=${encoded}`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(Buffer.from(attachment.data || '', 'base64'))
      );
    }
    parts.push(`--${boundary}--`);
    body = parts.join('\r\n');
  } else {
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    body = alternative;
  }

  const raw = `${headers.join('\r\n')}\r\n\r\n${body}`;
  if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new MimeError('Message exceeds the 25 MB Gmail limit.');
  }
  return raw;
}

export function toBase64Url(raw) {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export { MAX_MESSAGE_BYTES };