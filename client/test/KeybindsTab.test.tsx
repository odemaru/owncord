import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KeybindsTab } from '../src/components/settings/KeybindsTab';

// Вкладка «Горячие клавиши» должна работать и в браузере. Раньше она была
// desktopOnly, и весь раздел на вебе просто не существовал.

let isDesktopValue = false;
const settings: any = { keybinds: { toggleMute: null, toggleDeafen: null } };
const update = vi.fn((patch: any) => Object.assign(settings, patch));

vi.mock('../src/context/SettingsContext', () => ({
  useSettings: () => ({ settings, update }),
}));

vi.mock('../src/utils/desktop', async (importOriginal) => {
  // Конвертеры accelerator'ов оставляем настоящими — тест проверяет и то,
  // что записанная комбинация совпадает с реальным форматом.
  const actual = await importOriginal<typeof import('../src/utils/desktop')>();
  return { ...actual, isDesktop: () => isDesktopValue };
});

beforeEach(() => {
  isDesktopValue = false;
  settings.keybinds = { toggleMute: null, toggleDeafen: null };
  update.mockClear();
});

describe('KeybindsTab', () => {
  it('рендерит обе привязки в браузере', () => {
    // Регрессия: содержимое вкладки было закрыто гейтом по desktop и
    // раздел открывался пустым, хотя сама вкладка в списке появилась.
    render(<KeybindsTab />);
    expect(screen.getByText('Мьют микрофона')).toBeInTheDocument();
    expect(screen.getByText('Глушить динамики')).toBeInTheDocument();
    expect(screen.getAllByText('Не назначено')).toHaveLength(2);
  });

  it('в браузере честно говорит про ограничение фокуса', () => {
    render(<KeybindsTab />);
    expect(screen.getByText(/пока вкладка OwnCord активна/i)).toBeInTheDocument();
  });

  it('в десктопе обещает глобальные хоткеи', () => {
    isDesktopValue = true;
    render(<KeybindsTab />);
    expect(screen.getByText(/свёрнуто или не в фокусе/i)).toBeInTheDocument();
  });

  it('записывает нажатую комбинацию', () => {
    render(<KeybindsTab />);
    // Кнопка с текущим значением — она же кнопка «Записать».
    fireEvent.click(screen.getAllByText('Не назначено')[0]);
    expect(screen.getByText(/Нажми клавишу или мышь/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { code: 'KeyM', ctrlKey: true, shiftKey: true });
    expect(update).toHaveBeenCalledWith({
      keybinds: { toggleMute: 'CommandOrControl+Shift+M', toggleDeafen: null },
    });
  });

  it('Esc отменяет запись', () => {
    render(<KeybindsTab />);
    fireEvent.click(screen.getAllByText('Не назначено')[0]);
    fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' });
    expect(update).not.toHaveBeenCalled();
    expect(screen.queryByText(/Нажми клавишу или мышь/i)).not.toBeInTheDocument();
  });

  it('показывает уже назначенную комбинацию', () => {
    settings.keybinds = { toggleMute: 'F8', toggleDeafen: null };
    render(<KeybindsTab />);
    // Ищем именно кнопку записи, а не текст вообще: «F8» встречается ещё
    // и в примере формата в шапке вкладки.
    const buttons = screen.getAllByTitle('Записать новую комбинацию');
    expect(buttons[0]).toHaveTextContent('F8');
    expect(buttons[1]).toHaveTextContent('Не назначено');
  });
});
