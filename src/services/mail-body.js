function decode(data) {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf8');
}

function eachPart(payload, visit) {
  if (!payload) return;
  visit(payload);
  for (const part of payload.parts || []) eachPart(part, visit);
}

export function parseMessageBody(message = {}) {
  const bodies = { text: '', html: '' };
  const attachments = [];

  eachPart(message.payload, (part) => {
    const mime = part.mimeType || '';
    const filename = part.filename || '';
    const attachmentId = part.body?.attachmentId;
    if (attachmentId) {
      attachments.push({
        part_id: part.partId || attachmentId,
        filename: filename || 'attachment',
        mime_type: mime || 'application/octet-stream',
        size: Number(part.body?.size) || 0,
        attachment_id: attachmentId,
        content_id: (part.headers || []).find((header) => header.name.toLowerCase() === 'content-id')?.value || '',
        is_inline: Boolean(part.headers?.some((header) =>
          header.name.toLowerCase() === 'content-disposition'
          && header.value.toLowerCase().startsWith('inline')))
      });
      return;
    }
    if (mime === 'text/html' && !bodies.html) bodies.html = decode(part.body?.data);
    if (mime === 'text/plain' && !bodies.text) bodies.text = decode(part.body?.data);
  });

  if (!bodies.text && message.payload?.mimeType === 'text/plain') {
    bodies.text = decode(message.payload.body?.data);
  }
  if (!bodies.html && message.payload?.mimeType === 'text/html') {
    bodies.html = decode(message.payload.body?.data);
  }
  return { ...bodies, attachments };
}

export function rewriteInlineImages(html, attachments, accountId, messageId, urlFor) {
  if (!html) return '';
  let output = html;
  for (const attachment of attachments) {
    if (!attachment.content_id) continue;
    const cid = attachment.content_id.replace(/^<|>$/g, '');
    if (!cid) continue;
    const query = new URLSearchParams({
      name: attachment.filename,
      type: attachment.mime_type
    });
    if (attachment.is_inline) query.set('inline', '1');
    const url = urlFor
      ? urlFor(attachment)
      : `/api/attachments/${accountId}/${encodeURIComponent(messageId)}/${encodeURIComponent(attachment.attachment_id)}?${query}`;
    output = output.replaceAll(`cid:${cid}`, url).replaceAll(`cid:${attachment.content_id}`, url);
  }
  return output;
}

export function safeAttachmentName(name) {
  return String(name || 'attachment')
    .replace(/[\r\n"\\]/g, '')
    .replace(/[^\w.\- ()]/g, '_')
    .slice(0, 180) || 'attachment';
}