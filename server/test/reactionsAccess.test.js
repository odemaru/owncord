import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import db from '../src/db.js';
import { buildTestApp } from './appFactory.js';
import { absolutePathFor, UPLOADS_DIR } from '../src/uploads.js';
import path from 'node:path';

// Регрессия на IDOR в реакциях: до фикса POST/GET /api/messages/:id/reaction(s)
// не проверяли, имеет ли вызывающий доступ к сообщению. Любой залогиненный
// юзер мог перебором id ставить реакции в чужих личных переписках и читать,
// кто и чем там отреагировал.

let app;
let aliceToken;
let aliceId;
let bobToken;
let bobId;
let malloryToken;

beforeAll(async () => {
  app = buildTestApp();
  const a = await request(app)
    .post('/api/auth/register')
    .send({ username: 'alice_react', password: 'secret123' });
  aliceToken = a.body.token;
  aliceId = a.body.user.id;
  const b = await request(app)
    .post('/api/auth/register')
    .send({ username: 'bob_react', password: 'secret123' });
  bobToken = b.body.token;
  bobId = b.body.user.id;
  const m = await request(app)
    .post('/api/auth/register')
    .send({ username: 'mallory_react', password: 'secret123' });
  malloryToken = m.body.token;
});

function insertDm({ from, to, content, createdAt }) {
  const info = db
    .prepare(
      `INSERT INTO messages (sender_id, receiver_id, content, created_at, kind)
       VALUES (?, ?, ?, ?, 'text')`,
    )
    .run(from, to, content, createdAt ?? Date.now());
  return info.lastInsertRowid;
}

describe('reactions access control', () => {
  it('посторонний не может поставить реакцию в чужой переписке', async () => {
    const id = insertDm({ from: aliceId, to: bobId, content: 'приватное' });
    const res = await request(app)
      .post(`/api/messages/${id}/reaction`)
      .set('Authorization', `Bearer ${malloryToken}`)
      .send({ emoji: '🔥' });
    expect(res.status).toBe(403);
    // И реакция не должна была записаться.
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = ?')
      .get(id);
    expect(count.n).toBe(0);
  });

  it('посторонний не может прочитать реакции чужой переписки', async () => {
    const id = insertDm({ from: aliceId, to: bobId, content: 'ещё приватное' });
    const res = await request(app)
      .get(`/api/messages/${id}/reactions`)
      .set('Authorization', `Bearer ${malloryToken}`);
    expect(res.status).toBe(403);
  });

  it('участник переписки реакцию поставить может', async () => {
    const id = insertDm({ from: aliceId, to: bobId, content: 'для боба' });
    const res = await request(app)
      .post(`/api/messages/${id}/reaction`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ emoji: '🔥' });
    expect(res.status).toBe(200);
    expect(res.body.reactions).toEqual([{ emoji: '🔥', count: 1, users: [bobId] }]);
  });

  it('участник переписки реакции прочитать может', async () => {
    const id = insertDm({ from: aliceId, to: bobId, content: 'читаем' });
    await request(app)
      .post(`/api/messages/${id}/reaction`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ emoji: '👍' });
    const res = await request(app)
      .get(`/api/messages/${id}/reactions`)
      .set('Authorization', `Bearer ${aliceToken}`);
    expect(res.status).toBe(200);
    expect(res.body.reactions).toEqual([{ emoji: '👍', count: 1, users: [bobId] }]);
  });

  it('слишком длинная «эмодзи»-строка отвергается', async () => {
    const id = insertDm({ from: aliceId, to: bobId, content: 'спам' });
    const res = await request(app)
      .post(`/api/messages/${id}/reaction`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ emoji: 'x'.repeat(5000) });
    expect(res.status).toBe(400);
  });
});

describe('история чата отдаёт последние сообщения, а не первые', () => {
  it('при переполнении лимита в выдаче лежит свежий хвост', async () => {
    const c = await request(app)
      .post('/api/auth/register')
      .send({ username: 'carol_hist', password: 'secret123' });
    const carolToken = c.body.token;
    const carolId = c.body.user.id;
    const d = await request(app)
      .post('/api/auth/register')
      .send({ username: 'dave_hist', password: 'secret123' });
    const daveId = d.body.user.id;

    // 520 сообщений при лимите 500: первые 20 обязаны выпасть из выдачи.
    const base = Date.now() - 520 * 1000;
    const insert = db.prepare(
      `INSERT INTO messages (sender_id, receiver_id, content, created_at, kind)
       VALUES (?, ?, ?, ?, 'text')`,
    );
    const many = db.transaction(() => {
      for (let i = 0; i < 520; i += 1) {
        insert.run(carolId, daveId, `msg-${i}`, base + i * 1000);
      }
    });
    many();

    const res = await request(app)
      .get(`/api/messages/${daveId}`)
      .set('Authorization', `Bearer ${carolToken}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(500);
    // Самое свежее — последнее в массиве (UI ждёт хронологию).
    expect(res.body.messages.at(-1).content).toBe('msg-519');
    // Хвост начинается с 20-го, а не с нулевого.
    expect(res.body.messages[0].content).toBe('msg-20');
  });
});

describe('absolutePathFor не выпускает за пределы uploads', () => {
  it('обычный путь резолвится', () => {
    expect(absolutePathFor('/uploads/files/a.png')).toBe(
      path.join(UPLOADS_DIR, 'files', 'a.png'),
    );
  });

  it('обход по префиксу каталога отбивается', () => {
    // Классический трюк: «..» выводит в каталог-сосед, имя которого
    // начинается так же, как UPLOADS_DIR. Голый startsWith это пропускал.
    expect(absolutePathFor('/uploads/../uploads-backup/secret.sqlite')).toBeNull();
  });

  it('обычный traversal вверх отбивается', () => {
    expect(absolutePathFor('/uploads/../../etc/passwd')).toBeNull();
  });

  it('чужой префикс пути отбивается', () => {
    expect(absolutePathFor('/etc/passwd')).toBeNull();
  });
});
