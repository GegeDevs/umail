const MESSAGE_COLUMNS = [
  'account_id', 'gmail_message_id', 'gmail_thread_id', 'internal_date',
  'from_name', 'from_email', 'to_json', 'cc_json', 'bcc_json', 'reply_to',
  'subject', 'snippet', 'label_ids', 'size_estimate', 'is_unread',
  'is_starred', 'is_important', 'has_attachment', 'raw_headers_json'
];

const MESSAGE_UPSERT = `
  INSERT INTO messages (${MESSAGE_COLUMNS.join(', ')})
  VALUES (${MESSAGE_COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT(account_id, gmail_message_id) DO UPDATE SET
    gmail_thread_id = excluded.gmail_thread_id,
    internal_date = excluded.internal_date,
    from_name = excluded.from_name,
    from_email = excluded.from_email,
    to_json = excluded.to_json,
    cc_json = excluded.cc_json,
    bcc_json = excluded.bcc_json,
    reply_to = excluded.reply_to,
    subject = excluded.subject,
    snippet = excluded.snippet,
    label_ids = excluded.label_ids,
    size_estimate = excluded.size_estimate,
    is_unread = excluded.is_unread,
    is_starred = excluded.is_starred,
    is_important = excluded.is_important,
    has_attachment = excluded.has_attachment,
    raw_headers_json = excluded.raw_headers_json
`;

function messageArgs(message) {
  return [
    message.account_id, message.gmail_message_id, message.gmail_thread_id, message.internal_date,
    message.from_name, message.from_email, message.to_json, message.cc_json, message.bcc_json,
    message.reply_to, message.subject, message.snippet, message.label_ids, message.size_estimate,
    message.is_unread, message.is_starred, message.is_important, message.has_attachment,
    message.raw_headers_json
  ];
}

function threadStatements(accountId, threadIds) {
  if (!threadIds.length) return [];
  const placeholders = threadIds.map(() => '?').join(',');
  const latest = (column) => `(
    SELECT x.${column} FROM messages x
    WHERE x.account_id = m.account_id AND x.gmail_thread_id = m.gmail_thread_id
    ORDER BY x.internal_date DESC, x.id DESC LIMIT 1
  )`;
  return [
    {
      sql: `
        INSERT INTO threads
          (account_id, gmail_thread_id, subject, snippet, last_message_at,
           message_count, label_ids, is_unread, is_starred, is_important)
        SELECT
          m.account_id, m.gmail_thread_id, ${latest('subject')}, ${latest('snippet')},
          MAX(m.internal_date), COUNT(*), ${latest('label_ids')},
          MAX(m.is_unread), MAX(m.is_starred), MAX(m.is_important)
        FROM messages m
        WHERE m.account_id = ? AND m.gmail_thread_id IN (${placeholders})
        GROUP BY m.account_id, m.gmail_thread_id
        ON CONFLICT(account_id, gmail_thread_id) DO UPDATE SET
          subject = excluded.subject,
          snippet = excluded.snippet,
          last_message_at = excluded.last_message_at,
          message_count = excluded.message_count,
          label_ids = excluded.label_ids,
          is_unread = excluded.is_unread,
          is_starred = excluded.is_starred,
          is_important = excluded.is_important
      `,
      args: [accountId, ...threadIds]
    },
    {
      sql: `
        DELETE FROM threads
        WHERE account_id = ? AND gmail_thread_id IN (${placeholders})
          AND NOT EXISTS (
            SELECT 1 FROM messages m
            WHERE m.account_id = threads.account_id
              AND m.gmail_thread_id = threads.gmail_thread_id
          )
      `,
      args: [accountId, ...threadIds]
    }
  ];
}

export async function recomputeThreads(db, accountId, threadIds) {
  if (!threadIds.length) return 0;
  await db.batch(threadStatements(accountId, threadIds));
  return threadIds.length;
}

export async function storeMessages(db, accountId, messages) {
  if (!messages.length) return { count: 0, threadIds: [] };
  const threadIds = [...new Set(messages.map((message) => message.gmail_thread_id))];
  const statements = messages.map((message) => ({ sql: MESSAGE_UPSERT, args: messageArgs(message) }));
  statements.push(...threadStatements(accountId, threadIds));
  await db.batch(statements);
  return { count: messages.length, threadIds };
}

export async function deleteMessages(db, accountId, messageIds) {
  const ids = [...new Set(messageIds)];
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db.prepare(`
    SELECT DISTINCT gmail_thread_id FROM messages
    WHERE account_id = ? AND gmail_message_id IN (${placeholders})
  `).bind(accountId, ...ids).all();
  const statements = ids.map((id) => ({
    sql: 'DELETE FROM messages WHERE account_id = ? AND gmail_message_id = ?',
    args: [accountId, id]
  }));
  statements.push(...threadStatements(accountId, results.map((row) => row.gmail_thread_id)));
  await db.batch(statements);
  return ids.length;
}

export async function storeAttachments(db, accountId, messageId, attachments) {
  const statements = [{
    sql: 'DELETE FROM attachments WHERE account_id = ? AND message_id = ?',
    args: [accountId, messageId]
  }];
  for (const attachment of attachments) {
    statements.push({
      sql: `
        INSERT INTO attachments
          (account_id, message_id, part_id, filename, mime_type, size, content_id, is_inline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        accountId, messageId, attachment.part_id, attachment.filename,
        attachment.mime_type, attachment.size || 0, attachment.content_id || null,
        attachment.is_inline ? 1 : 0
      ]
    });
  }
  await db.batch(statements);
  return attachments.length;
}

export async function storeLabels(db, accountId, labels) {
  if (!labels.length) return 0;
  const statements = labels.map((label) => ({
    sql: `
      INSERT INTO labels
        (account_id, gmail_label_id, name, type, color,
         messages_total, messages_unread, threads_total, threads_unread)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, gmail_label_id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        color = excluded.color,
        messages_total = excluded.messages_total,
        messages_unread = excluded.messages_unread,
        threads_total = excluded.threads_total,
        threads_unread = excluded.threads_unread
    `,
    args: [
      accountId, label.id, label.name, String(label.type || 'user').toLowerCase(),
      label.color?.backgroundColor || null,
      Number(label.messagesTotal) || 0, Number(label.messagesUnread) || 0,
      Number(label.threadsTotal) || 0, Number(label.threadsUnread) || 0
    ]
  }));
  await db.batch(statements);
  return statements.length;
}