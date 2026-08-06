import { Router } from 'express';
import fs from 'node:fs';
import db from '../db.js';
import { authRequired } from '../auth.js';
import {
  uploadVoice,
  uploadAttachment,
  publicPathFor,
  absolutePathFor,
  sniff,
} from '../uploads.js';
import { emitToPair, emitToGroup } from '../ioHub.js';
import { pushToUser, pushToUsers } from '../push.js';

const router = Router();

// Резолвит превью оригинального сообщения по id. Используется для поля
// replyTo: UI рисует в верху бабла цитату «<автор>: <текст/тип>». Превью
// содержит только то, что нужно для отрисовки — id, автора, краткий
// content, kind, флаг deleted, attachmentPath (для превью медиа). Если
// оригинал жёстко удалён (hard-delete или FK ON DELETE SET NULL) —
// возвращаем null, UI покажет «удалённое сообщение». Soft-delete
// (deleted=1) пробрасывается отдельным флагом, чтобы UI отличал «удалено
// автором» от «не найдено».
function resolveReplyPreview(replyToId) {
  if (!replyToId) return null;
  const r = db
    .prepare(
      `SELECT id, sender_id, content, kind, deleted, attachment_path
         FROM messages WHERE id = ?`,
    )
    .get(replyToId);
  if (!r) return null;
  return {
    id: r.id,
    senderId: r.sender_id,
    // Обрезаем превью: 200 символов хватает для подсветки в цитате, не
    // раздуваем payload при доставке через сокеты.
    content: r.deleted ? '' : (r.content || '').slice(0, 200),
    kind: r.kind || 'text',
    deleted: !!r.deleted,
    attachmentPath: r.attachment_path || null,
  };
}

function rowToMessage(row) {
  if (!row) return null;
  let payload = null;
  const raw = row.payload ?? row.payloadJson ?? null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      /* ignore */
    }
  }
  const replyToId = row.reply_to_message_id ?? row.replyToMessageId ?? null;
  return {
    id: row.id,
    senderId: row.sender_id ?? row.senderId,
    receiverId: row.receiver_id ?? row.receiverId ?? null,
    groupId: row.group_id ?? row.groupId ?? null,
    content: row.deleted ? '' : row.content || '',
    createdAt: row.created_at ?? row.createdAt,
    editedAt: row.edited_at ?? row.editedAt ?? null,
    deleted: !!(row.deleted ?? 0),
    kind: row.kind || 'text',
    attachmentPath: row.attachment_path ?? row.attachmentPath ?? null,
    durationMs: row.duration_ms ?? row.durationMs ?? null,
    attachmentName: row.attachment_name ?? row.attachmentName ?? null,
    attachmentSize: row.attachment_size ?? row.attachmentSize ?? null,
    attachmentMime: row.attachment_mime ?? row.attachmentMime ?? null,
    payload,
    // Только для DM. Для group_id всегда null (галочки в группах не показываем).
    readAt: row.read_at ?? row.readAt ?? null,
    // Пересылка: если был проставлен источник — вернём {senderId, messageId, createdAt}
    // для плашки «Переслано от X» в UI. Иначе null.
    forwardedFrom:
      row.forwarded_from_user_id != null || row.forwardedFromUserId != null
        ? {
            senderId: row.forwarded_from_user_id ?? row.forwardedFromUserId ?? null,
            messageId: row.forwarded_from_message_id ?? row.forwardedFromMessageId ?? null,
            createdAt: row.forwarded_from_created_at ?? row.forwardedFromCreatedAt ?? null,
          }
        : null,
    // Ответ на сообщение: превью оригинала для UI-цитаты.
    replyTo: resolveReplyPreview(replyToId),
  };
}

const MSG_COLS = `id, sender_id, receiver_id, group_id, content, created_at, edited_at, deleted,
              kind, attachment_path, duration_ms, attachment_name, attachment_size, attachment_mime,
              payload, read_at, forwarded_from_user_id, forwarded_from_message_id,
              forwarded_from_created_at, reply_to_message_id`;

// Проверяет валидность replyToId и возвращает либо корректный id, либо
// объект ошибки. Правила:
//   - replyToId необязателен (null/undefined) → null;
//   - должен быть целым числом;
//   - оригинал должен существовать;
//   - оригинал должен быть в ТОМ ЖЕ чате, что и новое сообщение
//     (нельзя ответить на сообщение из чужой переписки);
// Это валидируется отдельно от прав на отправку, поэтому вызывается
// после проверки доступа к целевому чату.
export function validateReplyTo(replyToId, ctx) {
  if (replyToId === undefined || replyToId === null) return { id: null };
  if (!Number.isInteger(replyToId)) return { error: 'bad replyToId' };
  const orig = db
    .prepare('SELECT sender_id, receiver_id, group_id FROM messages WHERE id = ?')
    .get(replyToId);
  if (!orig) return { error: 'reply target not found' };
  // Для группы: оригинал должен принадлежать той же группе.
  if (ctx.groupId != null) {
    if (orig.group_id !== ctx.groupId) return { error: 'reply target in another chat' };
    return { id: replyToId };
  }
  // Для DM: оригинал должен быть DM-сообщением и быть в переписке
  // между me и peer (в любую сторону).
  const me = ctx.me;
  const peer = ctx.peerId;
  if (orig.group_id != null) return { error: 'reply target in another chat' };
  const isOk =
    (orig.sender_id === me && orig.receiver_id === peer) ||
    (orig.sender_id === peer && orig.receiver_id === me);
  if (!isOk) return { error: 'reply target in another chat' };
  return { id: replyToId };
}

export { rowToMessage, MSG_COLS };

// Универсальный emit обновления сообщения — либо в пару, либо в группу
// (в зависимости от того, что у него установлено). Все участники подписаны
// на group:<id> комнату при connect / при добавлении в группу, поэтому
// дополнительно слать в персональные комнаты не нужно — это приводило бы
// к двойной доставке (сокет одновременно в group:<id> и user:<id>).
function emitMessage(event, row, payload) {
  if (row.group_id) {
    emitToGroup(row.group_id, event, payload);
  } else {
    emitToPair(row.sender_id, row.receiver_id, event, payload);
  }
}

function getMessage(id) {
  return db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(id);
}

function getReactionsForMessage(messageId) {
  const reactions = db
    .prepare(
      `SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as users
     FROM message_reactions WHERE message_id = ? GROUP BY emoji`,
    )
    .all(messageId);
  return reactions.map((r) => ({
    emoji: r.emoji,
    count: r.count,
    users: r.users ? r.users.split(',').map(Number) : [],
  }));
}

function canAccessRow(userId, row) {
  if (!row) return false;
  if (row.group_id) {
    return !!db
      .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(row.group_id, userId);
  }
  return row.sender_id === userId || row.receiver_id === userId;
}

// История переписки с конкретным пользователем.
router.get('/:peerId', authRequired, (req, res) => {
  const peerId = Number(req.params.peerId);
  if (!Number.isInteger(peerId)) return res.status(400).json({ error: 'bad peerId' });
  const me = req.user.id;
  // Берём ПОСЛЕДНИЕ 500 сообщений, а не первые.
  //
  // Раньше здесь было `ORDER BY created_at ASC LIMIT 500`, что в переписке
  // длиннее 500 сообщений отдавало самые старые — открыв такой чат, юзер
  // видел переписку годовой давности и ни одного свежего сообщения.
  // Сортируем по убыванию, режем лимитом, затем разворачиваем обратно
  // в хронологический порядок, который ожидает UI.
  //
  // Тай-брейк по id обязателен: created_at пишется в миллисекундах, и
  // сообщения, отправленные в одну миллисекунду, без него могли попасть
  // в срез в произвольном порядке.
  const rows = db
    .prepare(
      `SELECT ${MSG_COLS}
       FROM messages
       WHERE (sender_id = ? AND receiver_id = ?)
          OR (sender_id = ? AND receiver_id = ?)
       ORDER BY created_at DESC, id DESC
       LIMIT 500`,
    )
    .all(me, peerId, peerId, me)
    .reverse();
  const messages = rows.map(rowToMessage);
  // Загружаем реакции для каждого сообщения
  for (const msg of messages) {
    msg.reactions = getReactionsForMessage(msg.id);
  }
  res.json({ messages });
});

// Отправка голосового сообщения (multipart/form-data: file=voice, to=peerId, durationMs?, replyToId?).
router.post('/voice', authRequired, uploadVoice.single('voice'), sniff('audio'), (req, res) => {
  const to = Number(req.body.to);
  const durationMs = Number(req.body.durationMs) || null;
  if (!Number.isInteger(to)) return res.status(400).json({ error: 'bad to' });
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const peer = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
  if (!peer) return res.status(404).json({ error: 'no such user' });

  // replyToId опционален: голосовое может быть ответом на сообщение в DM.
  // FormData всё кодирует строкой → парсим, если строка задана.
  const rawReply = req.body.replyToId;
  const replyToIdRaw = rawReply === '' || rawReply === undefined ? null : Number(rawReply);
  const replyCheck = validateReplyTo(replyToIdRaw, { me: req.user.id, peerId: to });
  if (replyCheck.error) return res.status(400).json({ error: replyCheck.error });
  const replyToId = replyCheck.id;

  const pubPath = publicPathFor(req.file.path);
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO messages (sender_id, receiver_id, content, created_at, kind, attachment_path, duration_ms, reply_to_message_id)
       VALUES (?, ?, '', ?, 'voice', ?, ?, ?)`,
    )
    .run(req.user.id, to, now, pubPath, durationMs, replyToId);

  const msg = rowToMessage(getMessage(info.lastInsertRowid));
  emitToPair(req.user.id, to, 'dm:new', msg);
  res.json({ ok: true, message: msg });
});

// Отправка вложения произвольного типа (multipart/form-data: file, to, content?, replyToId?).
// Поддерживает multiple files через files[] array.
router.post('/file', authRequired, uploadAttachment.array('files', 10), sniff(), (req, res) => {
  const to = Number(req.body.to);
  if (!Number.isInteger(to)) return res.status(400).json({ error: 'bad to' });
  const files = Array.isArray(req.files) ? req.files : req.file ? [req.file] : [];
  if (files.length === 0) return res.status(400).json({ error: 'no file' });
  const peer = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
  if (!peer) return res.status(404).json({ error: 'no such user' });

  const caption =
    typeof req.body.content === 'string' ? req.body.content.trim().slice(0, 4000) : '';
  const rawReply = req.body.replyToId;
  const replyToIdRaw = rawReply === '' || rawReply === undefined ? null : Number(rawReply);
  const replyCheck = validateReplyTo(replyToIdRaw, { me: req.user.id, peerId: to });
  if (replyCheck.error) return res.status(400).json({ error: replyCheck.error });
  const replyToId = replyCheck.id;
  const now = Date.now();

  // Первый файл идёт в основные колонки, остальные - в payload
  const firstFile = files[0];
  const pubPath = publicPathFor(firstFile.path);
  const mime = firstFile.mimetype || 'application/octet-stream';
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file';

  let payload = null;
  if (files.length > 1) {
    const additionalAttachments = files.slice(1).map((f) => {
      const p = publicPathFor(f.path);
      const m = f.mimetype || 'application/octet-stream';
      const k = m.startsWith('image/') ? 'image' : m.startsWith('video/') ? 'video' : 'file';
      return {
        path: p,
        name: f.originalname,
        size: f.size,
        mime: m,
        kind: k,
      };
    });
    payload = { additionalAttachments };
  }

  const info = db
    .prepare(
      `INSERT INTO messages (
         sender_id, receiver_id, content, created_at, kind,
         attachment_path, attachment_name, attachment_size, attachment_mime, payload,
         reply_to_message_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      req.user.id,
      to,
      caption,
      now,
      kind,
      pubPath,
      firstFile.originalname,
      firstFile.size,
      mime,
      payload ? JSON.stringify(payload) : null,
      replyToId,
    );

  const msg = rowToMessage(getMessage(info.lastInsertRowid));
  emitToPair(req.user.id, to, 'dm:new', msg);
  res.json({ ok: true, message: msg });
});

// --- Пересылка сообщения ----------------------------------------------------
//
// POST /api/messages/:id/forward { to?: peerId, groupId?: gid }
//
// Создаёт КОПИЮ сообщения в указанном чате. Источник остаётся на месте.
// Файлы/payload не дублируем физически — копируем ссылку attachment_path.
// Это безопасно, потому что /uploads/* отдаются всем авторизованным юзерам
// (см. uploads.js): любой member нового чата всё равно увидит вложение.
//
// Пересылать НЕ разрешаем:
//   - удалённые сообщения (`deleted = 1`);
//   - системные / звонки (`kind in ('system','call','groupcall')`) — они
//     описывают событие конкретного чата, в другом контексте бессмысленны.
//
// В новой записи проставляются `forwarded_from_*`, чтобы UI показал
// «Переслано от <автор оригинала>». Если оригинал сам был пересланным,
// всё равно ссылаемся на ИСХОДНОГО автора (origin sender), а не на
// промежуточное звено — иначе цепочка пересылок размывает атрибуцию.
router.post('/:id/forward', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const me = req.user.id;

  const src = getMessage(id);
  if (!src) return res.status(404).json({ error: 'not found' });
  if (!canAccessRow(me, src)) return res.status(403).json({ error: 'forbidden' });
  if (src.deleted) return res.status(400).json({ error: 'cannot forward deleted' });
  if (src.kind === 'system' || src.kind === 'call' || src.kind === 'groupcall') {
    return res.status(400).json({ error: 'cannot forward system message' });
  }

  // Цель: ровно одна — DM или группа.
  const to = req.body?.to;
  const groupId = req.body?.groupId;
  const toUser = Number.isInteger(to);
  const toGroup = Number.isInteger(groupId);
  if (toUser === toGroup) return res.status(400).json({ error: 'need exactly one target' });

  if (toUser) {
    const peer = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
    if (!peer) return res.status(404).json({ error: 'no such user' });
  } else {
    const member = db
      .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(groupId, me);
    if (!member) return res.status(403).json({ error: 'not a group member' });
  }

  // Резолвим origin: если src уже переслан кем-то — ссылаемся на самого
  // первого автора (он же кладётся в forwarded_from_user_id), чтобы цепочка
  // пересылок «X→Y→Z» в плашке всегда показывала первоисточник X.
  const originUserId = src.forwarded_from_user_id ?? src.sender_id;
  const originMessageId = src.forwarded_from_message_id ?? src.id;
  const originCreatedAt = src.forwarded_from_created_at ?? src.created_at;

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO messages (
         sender_id, receiver_id, group_id, content, created_at, kind,
         attachment_path, duration_ms, attachment_name, attachment_size, attachment_mime,
         payload, forwarded_from_user_id, forwarded_from_message_id, forwarded_from_created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      me,
      toUser ? to : null,
      toGroup ? groupId : null,
      src.content || '',
      now,
      src.kind,
      src.attachment_path,
      src.duration_ms,
      src.attachment_name,
      src.attachment_size,
      src.attachment_mime,
      src.payload,
      originUserId,
      originMessageId,
      originCreatedAt,
    );

  // Бамп updated_at у группы, чтобы порядок чатов в сайдбаре поднялся.
  if (toGroup) {
    db.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').run(now, groupId);
  }

  const newRow = getMessage(info.lastInsertRowid);
  const msg = rowToMessage(newRow);
  emitMessage('dm:new', newRow, msg);

  // Web Push, как у обычной отправки.
  if (toUser) {
    const sender = db.prepare('SELECT username FROM users WHERE id = ?').get(me);
    pushToUser(to, {
      kind: 'dm',
      title: sender?.username || 'Сообщение',
      body: (src.content || 'Вложение').slice(0, 140),
      tag: `dm:${me}`,
      url: `/?dm=${me}`,
    }).catch(() => {});
  } else {
    const group = db.prepare('SELECT name FROM groups WHERE id = ?').get(groupId);
    const sender = db.prepare('SELECT username FROM users WHERE id = ?').get(me);
    const memberIds = db
      .prepare('SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?')
      .all(groupId, me)
      .map((r) => r.user_id);
    if (memberIds.length) {
      pushToUsers(memberIds, {
        kind: 'group',
        title: group?.name || 'Группа',
        body: `${sender?.username || ''}: ${(src.content || 'Вложение').slice(0, 120)}`,
        tag: `group:${groupId}`,
        url: `/?group=${groupId}`,
      }).catch(() => {});
    }
  }

  res.json({ ok: true, message: msg });
});

// Редактирование текстового сообщения (только своё, только text).
router.patch('/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'bad content' });
  const trimmed = content.trim();
  if (!trimmed) return res.status(400).json({ error: 'empty' });
  if (trimmed.length > 4000) return res.status(400).json({ error: 'too long' });

  const row = getMessage(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.sender_id !== req.user.id) return res.status(403).json({ error: 'not your message' });
  if (row.deleted) return res.status(400).json({ error: 'deleted' });
  if (row.kind !== 'text') return res.status(400).json({ error: 'not editable' });

  const editedAt = Date.now();
  db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(
    trimmed,
    editedAt,
    id,
  );

  const updated = rowToMessage(getMessage(id));
  emitMessage('dm:update', row, updated);
  res.json({ ok: true, message: updated });
});

// Удаление своего сообщения.
// Поведение зависит от настройки автора hide_on_delete:
//   - false (default): мягкое удаление, плашка "сообщение удалено" остаётся (dm:delete).
//   - true: жёсткое удаление, у обеих сторон сообщение полностью пропадает (dm:remove).
router.delete('/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const row = getMessage(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.sender_id !== req.user.id) return res.status(403).json({ error: 'not your message' });
  if (row.deleted) return res.json({ ok: true, message: rowToMessage(row) });

  // Удалим файл, если есть
  if (row.attachment_path) {
    const abs = absolutePathFor(row.attachment_path);
    if (abs)
      fs.promises.unlink(abs).catch(() => {
        /* ignore */
      });
  }

  const author = db.prepare('SELECT hide_on_delete FROM users WHERE id = ?').get(req.user.id);
  const hardRemove = !!author?.hide_on_delete;

  if (hardRemove) {
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    emitMessage('dm:remove', row, {
      id,
      senderId: row.sender_id,
      receiverId: row.receiver_id,
      groupId: row.group_id,
    });
    return res.json({ ok: true, removed: true });
  }

  db.prepare(
    `UPDATE messages SET deleted = 1, content = '', attachment_path = NULL,
       duration_ms = NULL, attachment_name = NULL, attachment_size = NULL, attachment_mime = NULL
     WHERE id = ?`,
  ).run(id);

  const updated = rowToMessage(getMessage(id));
  emitMessage('dm:delete', row, {
    id,
    senderId: row.sender_id,
    receiverId: row.receiver_id,
    groupId: row.group_id,
  });
  res.json({ ok: true, message: updated });
});

// --- Реакции на сообщения ---

// Добавить/удалить реакцию на личное сообщение
router.post('/:id/reaction', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const { emoji } = req.body;
  if (!emoji || typeof emoji !== 'string') return res.status(400).json({ error: 'invalid emoji' });
  // Ограничиваем длину: поле идёт прямиком в БД и в бродкаст по сокетам,
  // а на клиенте это одиночный эмодзи. Без лимита сюда можно положить
  // мегабайтную строку и разослать её всем участникам чата.
  if (emoji.length > 16) return res.status(400).json({ error: 'invalid emoji' });

  const msg = db
    .prepare('SELECT id, sender_id, receiver_id, group_id FROM messages WHERE id = ?')
    .get(id);
  if (!msg) return res.status(404).json({ error: 'message not found' });
  // КРИТИЧНО: без этой проверки любой залогиненный юзер мог перебором id
  // ставить реакции на сообщения в ЧУЖИХ личных переписках — и, за счёт
  // emitMessage ниже, ещё и получать уведомление о доставке в чат, к
  // которому не имеет отношения.
  if (!canAccessRow(req.user.id, msg)) return res.status(403).json({ error: 'forbidden' });
  if (msg.group_id) return res.status(400).json({ error: 'use group reaction endpoint' });
  if (msg.sender_id === req.user.id)
    return res.status(400).json({ error: 'cannot react to own message' });

  // Проверяем, есть ли уже такая реакция от этого пользователя
  const existing = db
    .prepare('SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .get(id, req.user.id, emoji);

  if (existing) {
    // Удаляем реакцию (toggle)
    db.prepare('DELETE FROM message_reactions WHERE id = ?').run(existing.id);
  } else {
    // Добавляем реакцию
    db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(
      id,
      req.user.id,
      emoji,
    );
  }

  // Получаем все реакции для этого сообщения
  const reactions = db
    .prepare(
      `SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as users
     FROM message_reactions WHERE message_id = ? GROUP BY emoji`,
    )
    .all(id);

  const reactionsMap = reactions.map((r) => ({
    emoji: r.emoji,
    count: r.count,
    users: r.users ? r.users.split(',').map(Number) : [],
  }));

  emitMessage('dm:reaction', msg, { messageId: Number(id), reactions: reactionsMap });
  res.json({ ok: true, reactions: reactionsMap });
});

// Получить реакции на личное сообщение
router.get('/:id/reactions', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const msg = db
    .prepare('SELECT id, sender_id, receiver_id, group_id FROM messages WHERE id = ?')
    .get(id);
  if (!msg) return res.status(404).json({ error: 'message not found' });
  // Та же дыра, что и в POST: без проверки доступа перебором id можно
  // вычитывать, кто и чем реагировал в чужих личных переписках.
  if (!canAccessRow(req.user.id, msg)) return res.status(403).json({ error: 'forbidden' });
  if (msg.group_id) return res.status(400).json({ error: 'use group reaction endpoint' });

  const reactions = db
    .prepare(
      `SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as users
     FROM message_reactions WHERE message_id = ? GROUP BY emoji`,
    )
    .all(id);

  const reactionsMap = reactions.map((r) => ({
    emoji: r.emoji,
    count: r.count,
    users: r.users ? r.users.split(',').map(Number) : [],
  }));

  res.json({ reactions: reactionsMap });
});

export default router;
