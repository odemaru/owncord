import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatPanel from '../src/components/ChatPanel';

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ auth: { token: 'test-token', user: { id: 1 } } }),
}));

const peer = {
  id: 2,
  username: 'bob',
  displayName: 'Bob',
  online: true,
};

const baseProps = {
  group: null,
  messages: [],
  selfId: 1,
  loading: false,
  onSend: vi.fn(),
  onSendVoice: vi.fn(),
  onSendFile: vi.fn(),
  onEditMessage: vi.fn(),
  onDeleteMessage: vi.fn(),
  onRejoinCall: vi.fn(),
  onCallAudio: vi.fn(),
  onCallVideo: vi.fn(),
  onBack: null,
  onShowProfile: vi.fn(),
  onShowGroupSettings: vi.fn(),
  onShowGroupMemberProfile: vi.fn(),
  onStartGroupCall: vi.fn(),
  onJoinGroupCall: vi.fn(),
  firstUnreadId: null,
  groupCallActive: false,
  inGroupCall: false,
  usersById: {},
};

describe('ChatPanel', () => {
  it('renders deleted peer chat as read-only', () => {
    render(
      <ChatPanel
        {...baseProps}
        peer={{ ...peer, deleted: true, username: null, displayName: null }}
      />,
    );

    expect(screen.getByText(/аккаунт был удалён/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Сообщение для/i)).toBeNull();
  });

  it('reports file-too-large through onSendFile callback', () => {
    const onSendFile = vi.fn();
    const { container } = render(
      <ChatPanel {...baseProps} peer={peer} onSendFile={onSendFile} maxFileBytes={4} />,
    );

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['too large'], 'large.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(onSendFile).toHaveBeenCalledWith(null, { error: 'too-large', limit: 4 });
  });

  it('reports typing start and stop from the message box', () => {
    const onTypingChange = vi.fn();
    render(<ChatPanel {...baseProps} peer={peer} onTypingChange={onTypingChange} />);

    const textarea = screen.getByPlaceholderText(/Сообщение для/i);
    fireEvent.change(textarea, { target: { value: 'п' } });
    fireEvent.change(textarea, { target: { value: '' } });

    expect(onTypingChange).toHaveBeenNthCalledWith(1, true);
    expect(onTypingChange).toHaveBeenNthCalledWith(2, false);
  });

  it('stops typing when sending a message', async () => {
    const onTypingChange = vi.fn();
    const onSend = vi.fn();
    render(
      <ChatPanel {...baseProps} peer={peer} onSend={onSend} onTypingChange={onTypingChange} />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Сообщение для/i), {
      target: { value: 'hello' },
    });
    fireEvent.click(screen.getByTitle('Отправить'));

    // ChatPanel зовёт onSend(text, replyToId) — второй аргумент появился
    // вместе с ответами на сообщения. Без цитаты он приходит как null,
    // поэтому проверяем именно два аргумента: toHaveBeenCalledWith('hello')
    // сверяет весь список целиком и на двухаргументном вызове краснеет.
    expect(onSend).toHaveBeenCalledWith('hello', null);
    await waitFor(() => {
      expect(onTypingChange).toHaveBeenLastCalledWith(false);
    });
  });

  it('stops typing when switching chats', () => {
    const onTypingChange = vi.fn();
    const { rerender } = render(
      <ChatPanel {...baseProps} peer={peer} onTypingChange={onTypingChange} />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Сообщение для/i), {
      target: { value: 'draft' },
    });
    rerender(
      <ChatPanel
        {...baseProps}
        peer={{ id: 3, username: 'cara', displayName: 'Cara', online: true }}
        onTypingChange={onTypingChange}
      />,
    );

    expect(onTypingChange).toHaveBeenLastCalledWith(false);
  });

  it('stops typing when starting voice recording', () => {
    const onTypingChange = vi.fn();
    render(<ChatPanel {...baseProps} peer={peer} onTypingChange={onTypingChange} />);

    fireEvent.change(screen.getByPlaceholderText(/Сообщение для/i), {
      target: { value: 'voice next' },
    });
    fireEvent.click(screen.getByTitle('Записать голосовое'));

    expect(onTypingChange).toHaveBeenLastCalledWith(false);
  });

  it('shows typing status in direct chat header', () => {
    render(<ChatPanel {...baseProps} peer={peer} typingUsers={[peer]} />);

    expect(screen.getByText('печатает…')).toBeInTheDocument();
  });

  it('shows grouped typing status in group chat header', () => {
    const bob = { id: 2, username: 'bob', displayName: 'Bob' };
    const cara = { id: 3, username: 'cara', displayName: 'Cara' };
    const dan = { id: 4, username: 'dan', displayName: 'Dan' };
    render(
      <ChatPanel
        {...baseProps}
        peer={null}
        group={{ id: 10, name: 'Alpha', members: [bob, cara, dan] }}
        typingUsers={[bob, cara, dan]}
      />,
    );

    expect(screen.getByText('Bob и ещё 2 печатают…')).toBeInTheDocument();
  });
});
