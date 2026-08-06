import { Router } from 'express';
import fs from 'node:fs';
import db from '../db.js';
import { authRequired } from '../auth.js';
import {
  uploadAvatar,
  uploadVoice,
  uploadAttachment,
  publicPathFor,
  absolutePathFor,
  sniff,
} from '../uploads.js';
import { emitToGroup, emitToUsers, joinUserToGroup, leaveUserFromGroup } from '../ioHub.js';
// rowToMessage/MSG_COLS/validateReplyTo — единые с DM-роутами (включают
// поля forwardedFrom, replyTo, reply_to_message_id и т.п.).
import { rowToMessage, MSG_COLS, validateReplyTo } from './messages.js';

const router = Router();

// Максимум участников в группе (сейчас MVP для mesh-звонков).
const MAX_MEMBERS = 10;
const NAME_MAX = 64;

// ---------- helpers ---------------------------------------------------------

function groupRow(id) {
  return db
    .prepare(
      'SELECT id, name, avatar_path, owner_id, created_at, updated_at FROM groups WHERE id = ?',
    )
    .get(id);
}

function memberIds(groupId) {
  return db
    .prepare('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at ASC')
    .all(groupId)
    .map((r) => r.user_id);
}

function membersDetailed(groupId) {
  return db
    .prepare(
      `SELECT gm.user_id AS id, gm.role, gm.joined_at,
              u.username, u.display_name AS displayName, u.avatar_path AS avatarPath
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ?
       ORDER BY gm.joined_at ASC`,
    )
    .all(groupId)
    .map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.displayName || r.username,
      avatarPath: r.avatarPath || null,
      role: r.role,
      joinedAt: r.joined_at,
    }));
}

function toGroup(row, members) {
  return {
    id: row.id,
    name: row.name,
    avatarPath: row.avatar_path || null,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    members,
  };
}

function isMember(groupId, userId) {
  return !!db
    .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
}

function isOwner(groupId, userId) {
  const row = db.prepare('SELECT owner_id FROM groups WHERE id = ?').get(groupId);
  return !!row && row.owner_id === userId;
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

/**
 * Вставляет системное сообщение в групповой чат и сразу эмитит его всем
 * подписчикам комнаты группы. Используется для событий состава (создание
 * группы, добавление/удаление/выход участника).
 *
 * payload.type: 'group_created' | 'member_added' | 'member_removed' | 'member_left'
 * actorId       — кто инициировал событие (создатель / owner / уходящий)
 * targetIds[]   — кого касается (для added/removed). Для group_created/member_left пусто.
 */
function insertSystemMessage(groupId, { type, actorId, targetIds = [] }) {
  const payload = { type, actorId, targetIds };
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO messages (sender_id, group_id, content, created_at, kind, payload)
       VALUES (?, ?, '', ?, 'system', ?)`,
    )
    .run(actorId, groupId, now, JSON.stringify(payload));
  db.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').run(now, groupId);
  const msg = rowToMessage(getMessage(info.lastInsertRowid));
  emitToGroup(groupId, 'dm:new', msg);
  return msg;
}

function validateName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.length > NAME_MAX) return null;
  return trimmed;
}

// ---------- список/детали --------------------------------------------------

router.get('/', authRequired, (req, res) => {
  const me = req.user.id;
  const rows = db
    .prepare(
      `SELECT g.id, g.name, g.avatar_path, g.owner_id, g.created_at, g.updated_at
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = ?
       ORDER BY g.updated_at DESC`,
    )
    .all(me);
  const groups = rows.map((r) => toGroup(r, membersDetailed(r.id)));
  res.json({ groups });
});

router.get('/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const row = groupRow(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'not a member' });
  res.json({ group: toGroup(row, membersDetailed(id)) });
});

// ---------- создание/редактирование ----------------------------------------

router.post('/', authRequired, (req, res) => {
  const { name, memberIds: raw } = req.body || {};
  const validName = validateName(name);
  if (!validName) return res.status(400).json({ error: 'bad name' });
  const ids = Array.isArray(raw) ? [...new Set(raw.map(Number).filter(Number.isInteger))] : [];
  // Создатель — всегда участник (owner). Не дублируем.
  const uniqMembers = ids.filter((i) => i !== req.user.id);
  if (uniqMembers.length < 1)
    return res.status(400).json({ error: 'need at least one other member' });
  if (uniqMembers.length + 1 > MAX_MEMBERS) {
    return res.status(400).json({ error: `too many members (max ${MAX_MEMBERS})` });
  }
  // Проверить, что все существуют.
  const placeholders = uniqMembers.map(() => '?').join(',');
  const existing = db
    .prepare(`SELECT id FROM users WHERE id IN (${placeholders})`)
    .all(...uniqMembers)
    .map((r) => r.id);
  if (existing.length !== uniqMembers.length) {
    return res.status(400).json({ error: 'some users not found' });
  }

  const now = Date.now();
  const info = db
    .prepare(`INSERT INTO groups (name, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(validName, req.user.id, now, now);
  const groupId = info.lastInsertRowid;

  const addMember = db.prepare(
    `INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`,
  );
  const tx = db.transaction((rows) => rows.forEach((r) => addMember.run(...r)));
  tx([
    [groupId, req.user.id, 'owner', now],
    ...uniqMembers.map((uid) => [groupId, uid, 'member', now]),
  ]);

  const full = toGroup(groupRow(groupId), membersDetailed(groupId));
  // Разошлём событие всем участникам и подпишем их сокеты на комнату.
  for (const uid of [req.user.id, ...uniqMembers]) {
    joinUserToGroup(uid, groupId);
  }
  emitToUsers([req.user.id, ...uniqMembers], 'group:new', full);
  // Системное сообщение «X создал группу».
  insertSystemMessage(groupId, { type: 'group_created', actorId: req.user.id });
  res.json({ group: full });
});

router.patch('/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const row = groupRow(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  // Owner и admin могут редактировать группу
  const member = db
    .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(id, req.user.id);
  if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
    return res.status(403).json({ error: 'owner or admin only' });
  }

  const { name } = req.body || {};
  if ('name' in (req.body || {})) {
    const v = validateName(name);
    if (!v) return res.status(400).json({ error: 'bad name' });
    db.prepare('UPDATE groups SET name = ?, updated_at = ? WHERE id = ?').run(v, Date.now(), id);
  }

  const full = toGroup(groupRow(id), membersDetailed(id));
  emitToGroup(id, 'group:update', full);
  emitToUsers(memberIds(id), 'group:update', full);
  res.json({ group: full });
});

router.delete('/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const row = groupRow(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const me = req.user.id;
  const owner = row.owner_id === me;
  if (!owner && !isMember(id, me)) return res.status(403).json({ error: 'not a member' });

  if (owner) {
    // Удалить группу — уведомим всех участников и аватарку.
    const allIds = memberIds(id);
    if (row.avatar_path) {
      const abs = absolutePathFor(row.avatar_path);
      if (abs)
        fs.promises.unlink(abs).catch(() => {
          /* ignore */
        });
    }
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    for (const uid of allIds) leaveUserFromGroup(uid, id);
    emitToUsers(allIds, 'group:delete', { id });
    return res.json({ ok: true, deleted: true });
  }

  // Обычный участник — просто выход.
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(id, me);
  // Сообщение «X вышел» — пока сокет ещё в комнате, он его получит.
  insertSystemMessage(id, { type: 'member_left', actorId: me });
  leaveUserFromGroup(me, id);

  const full = toGroup(groupRow(id), membersDetailed(id));
  emitToUser_byRoom(me, 'group:delete', { id });
  emitToGroup(id, 'group:update', full);
  emitToUsers(memberIds(id), 'group:update', full);
  res.json({ ok: true, left: true });
});

// Локальный хелпер, чтобы не тащить ioHub.emitToUsers для одного юзера
// в случае выхода.
function emitToUser_byRoom(userId, event, payload) {
  emitToUsers([userId], event, payload);
}

// ---------- участники ------------------------------------------------------

// Проверка прав: может ли текущий пользователь управлять ролями
// Только owner может управлять ролями (повышать/понижать)
function canManageRoles(groupId, userId) {
  const member = db
    .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
  if (!member) return false;
  return member.role === 'owner';
}

// Проверка: может ли текущий пользователь кикнуть целевого пользователя
function canKickUser(groupId, actorId, targetId) {
  const actor = db
    .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, actorId);
  const target = db
    .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, targetId);
  if (!actor || !target) return false;
  // Админ не может кикнуть создателя
  if (actor.role === 'admin' && target.role === 'owner') return false;
  // Админ не может кикнуть другого админа
  if (actor.role === 'admin' && target.role === 'admin') return false;
  // Создатель может кикнуть любого
  if (actor.role === 'owner') return true;
  // Админ может кикнуть только участников
  return actor.role === 'admin' && target.role === 'member';
}

// Изменение роли участника (повышение/понижение)
router.patch('/:id/members/:userId/role', authRequired, (req, res) => {
  const id = Number(req.params.id);
  const targetId = Number(req.params.userId);
  if (!Number.isInteger(id) || !Number.isInteger(targetId))
    return res.status(400).json({ error: 'bad id' });

  const { role } = req.body || {};
  if (!['owner', 'admin', 'member'].includes(role))
    return res.status(400).json({ error: 'invalid role' });

  const group = groupRow(id);
  if (!group) return res.status(404).json({ error: 'group not found' });

  // Проверяем что текущий пользователь может управлять ролями
  if (!canManageRoles(id, req.user.id))
    return res.status(403).json({ error: 'insufficient permissions' });

  // Проверяем что целевой пользователь существует в группе
  const targetMember = db
    .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(id, targetId);
  if (!targetMember) return res.status(404).json({ error: 'member not found' });

  // Создателя нельзя понизить или изменить его роль
  if (group.owner_id === targetId && role !== 'owner')
    return res.status(403).json({ error: 'cannot change owner role' });

  // Админ не может повысить до owner или понизить owner
  const actorRole = db
    .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(id, req.user.id).role;
  if (actorRole === 'admin' && role === 'owner')
    return res.status(403).json({ error: 'admins cannot promote to owner' });

  db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?').run(
    role,
    id,
    targetId,
  );

  const full = toGroup(group, membersDetailed(id));
  emitToGroup(id, 'group:update', full);
  res.json({ ok: true, group: full });
});

router.post('/:id/members', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const row = groupRow(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!isOwner(id, req.user.id)) return res.status(403).json({ error: 'owner only' });

  const { memberIds: raw } = req.body || {};
  const ids = Array.isArray(raw) ? [...new Set(raw.map(Number).filter(Number.isInteger))] : [];
  if (ids.length === 0) return res.status(400).json({ error: 'no members' });

  const existing = memberIds(id);
  const toAdd = ids.filter((i) => !existing.includes(i));
  if (existing.length + toAdd.length > MAX_MEMBERS) {
    return res.status(400).json({ error: `too many members (max ${MAX_MEMBERS})` });
  }

  // Проверить, что все существуют.
  if (toAdd.length > 0) {
    const placeholders = toAdd.map(() => '?').join(',');
    const found = db
      .prepare(`SELECT id FROM users WHERE id IN (${placeholders})`)
      .all(...toAdd)
      .map((r) => r.id);
    if (found.length !== toAdd.length)
      return res.status(400).json({ error: 'some users not found' });
  }

  const now = Date.now();
  const addStmt = db.prepare(
    `INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`,
  );
  const tx = db.transaction((rows) => rows.forEach((r) => addStmt.run(...r)));
  tx(toAdd.map((uid) => [id, uid, now]));
  db.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').run(now, id);

  for (const uid of toAdd) joinUserToGroup(uid, id);
  const full = toGroup(groupRow(id), membersDetailed(id));
  emitToUsers(memberIds(id), 'group:update', full);
  // Новым — отдельное 'group:new', чтобы UI сразу создал пункт в сайдбаре.
  if (toAdd.length > 0) {
    emitToUsers(toAdd, 'group:new', full);
    // Системное сообщение «X добавил Y, Z» — после joinUserToGroup,
    // чтобы новички тоже получили событие через group:<id> комнату.
    insertSystemMessage(id, {
      type: 'member_added',
      actorId: req.user.id,
      targetIds: toAdd,
    });
  }
  res.json({ group: full });
});

router.delete('/:id/members/:userId', authRequired, (req, res) => {
  const id = Number(req.params.id);
  const userId = Number(req.params.userId);
  if (!Number.isInteger(id) || !Number.isInteger(userId)) {
    return res.status(400).json({ error: 'bad id' });
  }
  const row = groupRow(id);
  if (!row) return res.status(404).json({ error: 'not found' });

  const me = req.user.id;
  const selfLeave = userId === me;

  // Проверка прав: можно ли кикнуть пользователя
  if (!selfLeave && !canKickUser(id, me, userId)) {
    return res.status(403).json({ error: 'not allowed' });
  }

  if (userId === row.owner_id) {
    return res.status(400).json({ error: 'cannot remove owner (delete the group)' });
  }
  if (!isMember(id, userId)) return res.status(404).json({ error: 'not a member' });

  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(id, userId);
  db.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').run(Date.now(), id);

  // Системное сообщение пишем ДО leaveUserFromGroup, чтобы уходящий тоже
  // успел его получить. Тип зависит от того, сам ли вышел или его кикнули.
  if (selfLeave) {
    insertSystemMessage(id, { type: 'member_left', actorId: userId });
  } else {
    insertSystemMessage(id, {
      type: 'member_removed',
      actorId: me,
      targetIds: [userId],
    });
  }

  leaveUserFromGroup(userId, id);
  const full = toGroup(groupRow(id), membersDetailed(id));
  emitToUsers([userId], 'group:delete', { id });
  emitToUsers(memberIds(id), 'group:update', full);
  res.json({ ok: true, group: full });
});

// ---------- аватар группы ---------------------------------------------------

router.post(
  '/:id/avatar',
  authRequired,
  uploadAvatar.single('avatar'),
  sniff('image'),
  (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    // Owner и admin могут загружать аватар
    const member = db
      .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(id, req.user.id);
    if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
      return res.status(403).json({ error: 'owner or admin only' });
    }
    if (!req.file) return res.status(400).json({ error: 'no file' });

    const old = db.prepare('SELECT avatar_path FROM groups WHERE id = ?').get(id);
    if (old?.avatar_path) {
      const abs = absolutePathFor(old.avatar_path);
      if (abs)
        fs.promises.unlink(abs).catch(() => {
          /* ignore */
        });
    }

    const pubPath = publicPathFor(req.file.path);
    db.prepare('UPDATE groups SET avatar_path = ?, updated_at = ? WHERE id = ?').run(
      pubPath,
      Date.now(),
      id,
    );

    const full = toGroup(groupRow(id), membersDetailed(id));
    emitToUsers(memberIds(id), 'group:update', full);
    res.json({ group: full });
  },
);

router.delete('/:id/avatar', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  // Owner и admin могут удалять аватар
  const member = db
    .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(id, req.user.id);
  if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
    return res.status(403).json({ error: 'owner or admin only' });
  }
  const row = groupRow(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.avatar_path) {
    const abs = absolutePathFor(row.avatar_path);
    if (abs)
      fs.promises.unlink(abs).catch(() => {
        /* ignore */
      });
  }
  db.prepare('UPDATE groups SET avatar_path = NULL, updated_at = ? WHERE id = ?').run(
    Date.now(),
    id,
  );
  const full = toGroup(groupRow(id), membersDetailed(id));
  emitToUsers(memberIds(id), 'group:update', full);
  res.json({ group: full });
});

// ---------- сообщения в группе ---------------------------------------------

router.get('/:id/messages', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'not a member' });
  // Последние 500, а не первые — см. подробный комментарий в
  // routes/messages.js (GET /:peerId). Сортируем по убыванию, режем
  // лимитом и разворачиваем обратно в хронологию для UI.
  const rows = db
    .prepare(
      `SELECT ${MSG_COLS} FROM messages
       WHERE group_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 500`,
    )
    .all(id)
    .reverse();
  const messages = rows.map(rowToMessage);
  // Загружаем реакции для каждого сообщения
  for (const msg of messages) {
    msg.reactions = getReactionsForMessage(msg.id);
  }
  res.json({ messages });
});

router.post('/:id/messages/text', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'not a member' });
  const { content, replyToId: rawReply } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'bad content' });
  const trimmed = content.trim();
  if (!trimmed) return res.status(400).json({ error: 'empty' });
  if (trimmed.length > 4000) return res.status(400).json({ error: 'too long' });

  const replyCheck = validateReplyTo(rawReply ?? null, { me: req.user.id, groupId: id });
  if (replyCheck.error) return res.status(400).json({ error: replyCheck.error });

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO messages (sender_id, group_id, content, created_at, kind, reply_to_message_id)
       VALUES (?, ?, ?, ?, 'text', ?)`,
    )
    .run(req.user.id, id, trimmed, now, replyCheck.id);
  db.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').run(now, id);

  const msg = rowToMessage(getMessage(info.lastInsertRowid));
  emitToGroup(id, 'dm:new', msg);
  res.json({ ok: true, message: msg });
});

router.post(
  '/:id/messages/voice',
  authRequired,
  uploadVoice.single('voice'),
  sniff('audio'),
  (req, res) => {
    const id = Number(req.params.id);
    const durationMs = Number(req.body.durationMs) || null;
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'not a member' });
    if (!req.file) return res.status(400).json({ error: 'no file' });

    const rawReply = req.body.replyToId;
    const replyToIdRaw = rawReply === '' || rawReply === undefined ? null : Number(rawReply);
    const replyCheck = validateReplyTo(replyToIdRaw, { me: req.user.id, groupId: id });
    if (replyCheck.error) return res.status(400).json({ error: replyCheck.error });

    const pubPath = publicPathFor(req.file.path);
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO messages (sender_id, group_id, content, created_at, kind, attachment_path, duration_ms, reply_to_message_id)
       VALUES (?, ?, '', ?, 'voice', ?, ?, ?)`,
      )
      .run(req.user.id, id, now, pubPath, durationMs, replyCheck.id);
    db.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').run(now, id);

    const msg = rowToMessage(getMessage(info.lastInsertRowid));
    emitToGroup(id, 'dm:new', msg);
    res.json({ ok: true, message: msg });
  },
);

router.post(
  '/:id/messages/file',
  authRequired,
  uploadAttachment.array('files', 10),
  sniff(),
  (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'not a member' });
    const files = Array.isArray(req.files) ? req.files : req.file ? [req.file] : [];
    if (files.length === 0) return res.status(400).json({ error: 'no file' });

    const caption =
      typeof req.body.content === 'string' ? req.body.content.trim().slice(0, 4000) : '';
    const rawReply = req.body.replyToId;
    const replyToIdRaw = rawReply === '' || rawReply === undefined ? null : Number(rawReply);
    const replyCheck = validateReplyTo(replyToIdRaw, { me: req.user.id, groupId: id });
    if (replyCheck.error) return res.status(400).json({ error: replyCheck.error });
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
         sender_id, group_id, content, created_at, kind,
         attachment_path, attachment_name, attachment_size, attachment_mime, payload,
         reply_to_message_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.user.id,
        id,
        caption,
        now,
        kind,
        pubPath,
        firstFile.originalname,
        firstFile.size,
        mime,
        payload ? JSON.stringify(payload) : null,
        replyCheck.id,
      );
    db.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').run(now, id);

    const msg = rowToMessage(getMessage(info.lastInsertRowid));
    emitToGroup(id, 'dm:new', msg);
    res.json({ ok: true, message: msg });
  },
);

// --- Реакции на сообщения ---

// Добавить/удалить реакцию на групповое сообщение
router.post('/:id/messages/:msgId/reaction', authRequired, (req, res) => {
  const { id, msgId } = req.params;
  const { emoji } = req.body;
  if (!emoji || typeof emoji !== 'string') return res.status(400).json({ error: 'invalid emoji' });

  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'not a member' });

  const msg = db
    .prepare('SELECT id, sender_id, group_id FROM messages WHERE id = ? AND group_id = ?')
    .get(msgId, id);
  if (!msg) return res.status(404).json({ error: 'message not found' });
  if (msg.sender_id === req.user.id)
    return res.status(400).json({ error: 'cannot react to own message' });

  // Проверяем, есть ли уже такая реакция от этого пользователя
  const existing = db
    .prepare('SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .get(msgId, req.user.id, emoji);

  if (existing) {
    // Удаляем реакцию (toggle)
    db.prepare('DELETE FROM message_reactions WHERE id = ?').run(existing.id);
  } else {
    // Добавляем реакцию
    db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(
      msgId,
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
    .all(msgId);

  const reactionsMap = reactions.map((r) => ({
    emoji: r.emoji,
    count: r.count,
    users: r.users ? r.users.split(',').map(Number) : [],
  }));

  emitToGroup(id, 'dm:reaction', { messageId: Number(msgId), reactions: reactionsMap });
  res.json({ ok: true, reactions: reactionsMap });
});

// Получить реакции на групповое сообщение
router.get('/:id/messages/:msgId/reactions', authRequired, (req, res) => {
  const { id, msgId } = req.params;
  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'not a member' });

  const msg = db.prepare('SELECT id FROM messages WHERE id = ? AND group_id = ?').get(msgId, id);
  if (!msg) return res.status(404).json({ error: 'message not found' });

  const reactions = db
    .prepare(
      `SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as users
     FROM message_reactions WHERE message_id = ? GROUP BY emoji`,
    )
    .all(msgId);

  const reactionsMap = reactions.map((r) => ({
    emoji: r.emoji,
    count: r.count,
    users: r.users ? r.users.split(',').map(Number) : [],
  }));

  res.json({ reactions: reactionsMap });
});

export default router;
