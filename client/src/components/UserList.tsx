import { useMemo, useState } from 'react';
import { Search, BellOff, Plus, Users as UsersIcon, Phone } from 'lucide-react';
import Avatar from './Avatar';
import { getAvatarUrl, getDisplayName } from '../utils/user';

function activityValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function maxActivity(...values) {
  return Math.max(...values.map(activityValue));
}

function sortByActivity(list, getActivity) {
  return list
    .map((item, index) => ({ item, index, activity: activityValue(getActivity(item)) }))
    .sort((a, b) => b.activity - a.activity || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * Сайдбар-список. Содержит две секции — "Группы" и "Пользователи" —
 * разделённые видимой чертой. Выбор хранится в объекте `selected`:
 *   { kind: 'user' | 'group', id }
 */
export default function UserList({
  users,
  groups = [],
  selected,
  onSelectUser = null,
  onSelectGroup = null,
  selfId,
  unread = {}, // peerId -> count (для юзеров)
  groupUnread = {}, // groupId -> count
  lastActivityByChat = {}, // chatKey -> timestamp
  mutedIds = {},
  activeGroupCalls = null, // Set<groupId> — где идёт групповой звонок
  onUserContextMenu = null,
  onGroupContextMenu = null,
  onCreateGroup = null,
}) {
  const [q, setQ] = useState('');

  const needle = q.trim().toLowerCase();
  const match = (s) => !needle || (s || '').toLowerCase().includes(needle);

  const filteredUsers = useMemo(() => {
    // Удалённые аккаунты в списке не показываем — звонить и писать им
    // нельзя, в общий контакт-лист им делать нечего. Их сообщения и
    // системные плашки в истории чатов отображаются отдельно (через
    // глобальный usersById, см. ChatPanel).
    const list = users.filter((u) => u.id !== selfId && !u.deleted);
    const matched = needle ? list.filter((u) => match(u.username) || match(u.displayName)) : list;
    return sortByActivity(matched, (u) =>
      maxActivity(lastActivityByChat[`u:${u.id}`], u.lastActivityAt),
    );
  }, [users, selfId, needle, lastActivityByChat]);

  const filteredGroups = useMemo(() => {
    const matched = needle ? groups.filter((g) => match(g.name)) : groups;
    return sortByActivity(matched, (g) =>
      maxActivity(lastActivityByChat[`g:${g.id}`], g.updatedAt),
    );
  }, [groups, needle, lastActivityByChat]);

  const online = filteredUsers.filter((u) => u.online);
  const offline = filteredUsers.filter((u) => !u.online);

  const isUserActive = (id) => selected?.kind === 'user' && selected.id === id;
  const isGroupActive = (id) => selected?.kind === 'group' && selected.id === id;

  return (
    // flex-1 + min-h-0 — UserList сам является flex-child'ом в `aside` (тоже
    // flex-col, см. Home.tsx). С `h-full` высота получалась = высоте aside,
    // и UserList выталкивал собственную хедер-секцию profile-bar за нижний
    // край (последний пользователь оказывался не виден). С flex-1 + min-h-0
    // он честно делит вертикальное место с profile-bar над собой, а вложенный
    // скроллер ниже корректно ограничивается оставшейся высотой.
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="p-3 border-b border-white/10">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
          />
          <input
            className="input pl-9"
            placeholder="Поиск пользователей и групп"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {/*
        flex-1 + min-h-0 — стандартный fix для «scrollbar в flex-column не работает,
        контейнер раздвигается контентом и обрезает последний элемент». Без min-h-0
        flex-child имеет min-height:auto, и список перерастает aside по высоте, а
        overflow-y-auto не активируется. С min-h-0 контейнер реально ограничен
        flex-1 share'ом, и нативный скроллбар появляется как только нужно.

        pb-4 (вместо общего p-2) даёт последнему ряду нормальный воздух снизу —
        иначе он «прилипает» к нижнему краю и под овершот-зону скроллбара.
      */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pt-2 pb-4 space-y-4">
        {/* --- Группы --- */}
        <div>
          <div className="flex items-center justify-between px-2 pb-1">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
              Группы{filteredGroups.length > 0 ? ` — ${filteredGroups.length}` : ''}
            </div>
            {onCreateGroup && (
              <button
                onClick={onCreateGroup}
                className="btn-ghost"
                title="Создать группу"
                type="button"
              >
                <Plus size={14} />
              </button>
            )}
          </div>
          {filteredGroups.length === 0 ? (
            <div className="px-2 text-xs text-slate-500 italic">
              {needle ? 'Ничего не найдено' : 'Пока нет групп. Создайте первую!'}
            </div>
          ) : (
            <div className="space-y-0.5">
              {filteredGroups.map((g) => (
                <GroupRow
                  key={g.id}
                  group={g}
                  active={isGroupActive(g.id)}
                  unreadCount={groupUnread[g.id] || 0}
                  callActive={!!activeGroupCalls?.has?.(g.id)}
                  onClick={() => onSelectGroup?.(g)}
                  onContextMenu={onGroupContextMenu}
                />
              ))}
            </div>
          )}
        </div>

        {/* Явный разделитель между группами и пользователями */}
        <div className="mx-2 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

        {/* --- Пользователи --- */}
        {online.length > 0 && (
          <Section title={`Онлайн — ${online.length}`}>
            {online.map((u) => (
              <UserRow
                key={u.id}
                user={u}
                active={isUserActive(u.id)}
                unreadCount={unread[u.id] || 0}
                muted={!!mutedIds[u.id]}
                onClick={() => onSelectUser?.(u)}
                onContextMenu={onUserContextMenu}
              />
            ))}
          </Section>
        )}
        {offline.length > 0 && (
          <Section title={`Оффлайн — ${offline.length}`}>
            {offline.map((u) => (
              <UserRow
                key={u.id}
                user={u}
                active={isUserActive(u.id)}
                unreadCount={unread[u.id] || 0}
                muted={!!mutedIds[u.id]}
                onClick={() => onSelectUser?.(u)}
                onContextMenu={onUserContextMenu}
              />
            ))}
          </Section>
        )}
        {filteredUsers.length === 0 && filteredGroups.length === 0 && (
          <div className="text-center text-slate-500 text-sm py-6">Ничего не найдено</div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div className="px-2 pb-1 text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function UserRow({ user, active, onClick, unreadCount = 0, muted, onContextMenu }) {
  const name = getDisplayName(user);
  const avatarUrl = getAvatarUrl(user);
  // Статус-надпись синхронна с цветом кружка в Avatar:
  // away (online && idle) → «не активен», online → «в сети», offline → «не в сети».
  const statusText = user.online ? (user.away ? 'не активен' : 'в сети') : 'не в сети';
  return (
    <button
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e, user);
      }}
      className={`list-row w-full text-left ${active ? 'list-row-active' : ''}`}
    >
      <Avatar
        name={name}
        src={avatarUrl}
        size={36}
        online={user.online}
        away={user.away}
        showStatus
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-slate-100 flex items-center gap-1.5">
          <span className={`truncate ${unreadCount ? 'font-semibold' : ''}`}>{name}</span>
          {muted && <BellOff size={12} className="text-slate-500 shrink-0" />}
        </div>
        <div className="text-xs text-slate-500 truncate">{statusText}</div>
      </div>
      {unreadCount > 0 && !muted && (
        <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-accent text-[11px] font-semibold text-white grid place-items-center">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  );
}

function GroupRow({ group, active, onClick, unreadCount = 0, callActive = false, onContextMenu }) {
  const name = group.name || 'Группа';
  const memberCount = group.members?.length ?? 0;
  return (
    <button
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e, group);
      }}
      className={`list-row w-full text-left ${active ? 'list-row-active' : ''}`}
    >
      <div className="relative shrink-0">
        {group.avatarPath ? (
          <Avatar name={name} src={group.avatarPath} size={36} />
        ) : (
          <div
            className="avatar grid place-items-center bg-bg-3/90 text-slate-200"
            style={{ width: 36, height: 36 }}
            aria-hidden
          >
            <UsersIcon size={18} />
          </div>
        )}
        {callActive && (
          <span
            className="status-dot absolute -bottom-0.5 -right-0.5 grid place-items-center w-4 h-4 rounded-full bg-success text-white animate-pulse"
            title="В этой группе сейчас идёт звонок"
            aria-label="Звонок"
          >
            <Phone size={9} />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-slate-100">
          <span className={`truncate ${unreadCount ? 'font-semibold' : ''}`}>{name}</span>
        </div>
        <div className="text-xs text-slate-500 truncate">
          {callActive ? <span className="text-success">Идёт звонок</span> : `${memberCount} участ.`}
        </div>
      </div>
      {unreadCount > 0 && (
        <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-accent text-[11px] font-semibold text-white grid place-items-center">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  );
}
