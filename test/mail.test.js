import { test, expect } from 'bun:test';
import { buildMime, encodeHeader, textToHtml } from '../src/services/mime.js';
import { parseMessageBody, rewriteInlineImages, safeAttachmentName } from '../src/services/mail-body.js';
import { parseRecipients } from '../src/services/mail-send.js';
import { applyLabelDelta } from '../src/services/mail-actions.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');

test('mime builds multipart alternative with reply headers and encoded subject', () => {
  const raw = buildMime({
    from: 'ada@example.com',
    to: ['bob@example.com'],
    cc: ['cc@example.com'],
    bcc: ['secret@example.com'],
    subject: 'Halo ñ',
    text: 'Hello\nworld',
    inReplyTo: '<x@y>',
    references: '<a@b> <x@y>'
  });
  expect(raw).toContain('From: ada@example.com');
  expect(raw).toContain('To: bob@example.com');
  expect(raw).toContain('Cc: cc@example.com');
  expect(raw).toContain('Bcc: secret@example.com');
  expect(raw).toContain('In-Reply-To: <x@y>');
  expect(raw).toContain('References: <a@b> <x@y>');
  expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
  expect(raw).toContain('multipart/alternative');
  expect(raw).toContain(Buffer.from(textToHtml('Hello\nworld'), 'utf8').toString('base64'));
  expect(encodeHeader('plain')).toBe('plain');
});

test('mime embeds attachments as base64', () => {
  const raw = buildMime({
    from: 'ada@example.com',
    to: ['bob@example.com'],
    subject: 'File',
    text: 'See attached',
    attachments: [{ name: 'note.txt', type: 'text/plain', data: Buffer.from('hello').toString('base64') }]
  });
  expect(raw).toContain('multipart/mixed');
  expect(raw).toContain('filename="note.txt"');
  expect(raw).toContain(Buffer.from('hello').toString('base64'));
});

test('recipient parsing validates, strips names, and dedupes', () => {
  expect(parseRecipients('A <A@Example.com>, bad, b@c.co; a@example.com')).toEqual(['a@example.com', 'b@c.co']);
  expect(parseRecipients(['x@y.co', ''])).toEqual(['x@y.co']);
  expect(parseRecipients('nope')).toEqual([]);
});

test('message body parser extracts html, text, and attachments', () => {
  const parsed = parseMessageBody({
    payload: {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('plain body') } },
            { mimeType: 'text/html', body: { data: b64('<p>html body <img src="cid:img1"></p>') } }
          ]
        },
        {
          partId: '2',
          mimeType: 'application/pdf',
          filename: 'report.pdf',
          body: { attachmentId: 'att1', size: 1024 },
          headers: [
            { name: 'Content-ID', value: '<img1>' },
            { name: 'Content-Disposition', value: 'inline; filename="report.pdf"' }
          ]
        }
      ]
    }
  });
  expect(parsed.text).toBe('plain body');
  expect(parsed.html).toContain('html body');
  expect(parsed.attachments).toHaveLength(1);
  expect(parsed.attachments[0].attachment_id).toBe('att1');
  expect(parsed.attachments[0].is_inline).toBe(true);

  const html = rewriteInlineImages(parsed.html, parsed.attachments, 7, 'm1');
  expect(html).toContain('/api/attachments/7/m1/att1');
  expect(html).not.toContain('cid:');
});

test('attachment names sanitize and label deltas merge', () => {
  expect(safeAttachmentName('../../evil\r\n.txt')).toBe('.._.._evil.txt');
  expect(applyLabelDelta(['INBOX', 'UNREAD'], { remove: ['UNREAD'], add: ['STARRED'] }))
    .toEqual(['INBOX', 'STARRED']);
});