export const METADATA_HEADERS = [
  'From', 'To', 'Cc', 'Bcc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References'
];

export function headerMap(headers = []) {
  const map = {};
  for (const header of headers) {
    if (!header?.name) continue;
    map[String(header.name).toLowerCase()] = String(header.value || '');
  }
  return map;
}

export function parseAddressList(value = '') {
  const parts = [];
  let current = '';
  let quoted = false;
  let angle = 0;

  for (const char of String(value)) {
    if (char === '"') quoted = !quoted;
    if (!quoted) {
      if (char === '<') angle += 1;
      if (char === '>' && angle > 0) angle -= 1;
      if (char === ',' && angle === 0) {
        if (current.trim()) parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());

  return parts.map(parseAddress).filter((address) => address.email);
}

export function parseAddress(value = '') {
  const raw = String(value).trim();
  const match = raw.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (match) {
    return {
      name: match[1].trim().replace(/^"|"$/g, '').trim(),
      email: match[2].trim().toLowerCase()
    };
  }
  return { name: '', email: raw.replace(/^"|"$/g, '').trim().toLowerCase() };
}

function hasAttachmentPart(payload) {
  if (!payload) return false;
  if (payload.filename) return true;
  if (Array.isArray(payload.parts)) return payload.parts.some(hasAttachmentPart);
  return false;
}

export function normalizeMessage(accountId, message) {
  const headers = headerMap(message.payload?.headers);
  const from = parseAddress(headers.from || '');
  const labelIds = Array.isArray(message.labelIds) ? message.labelIds : [];
  const internalDate = Number(message.internalDate) || Date.now();

  return {
    account_id: accountId,
    gmail_message_id: message.id,
    gmail_thread_id: message.threadId,
    internal_date: internalDate,
    from_name: from.name || null,
    from_email: from.email || null,
    to_json: JSON.stringify(parseAddressList(headers.to || '')),
    cc_json: JSON.stringify(parseAddressList(headers.cc || '')),
    bcc_json: JSON.stringify(parseAddressList(headers.bcc || '')),
    reply_to: parseAddressList(headers['reply-to'] || '')[0]?.email || null,
    subject: headers.subject || '',
    snippet: message.snippet || '',
    label_ids: JSON.stringify(labelIds),
    size_estimate: Number(message.sizeEstimate) || 0,
    is_unread: labelIds.includes('UNREAD') ? 1 : 0,
    is_starred: labelIds.includes('STARRED') ? 1 : 0,
    is_important: labelIds.includes('IMPORTANT') ? 1 : 0,
    has_attachment: hasAttachmentPart(message.payload) ? 1 : 0,
    raw_headers_json: JSON.stringify({
      messageId: headers['message-id'] || '',
      inReplyTo: headers['in-reply-to'] || '',
      references: headers.references || ''
    })
  };
}
