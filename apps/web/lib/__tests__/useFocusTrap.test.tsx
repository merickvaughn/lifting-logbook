import { useRef, useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFocusTrap } from '../useFocusTrap';
import type { FocusTrapOptions } from '../useFocusTrap';

type PageProps = Pick<FocusTrapOptions, 'returnFocus'> & { startOnSecond?: boolean };

/** A page with one control outside, and a dialog with three inside. */
function Page({ returnFocus, startOnSecond }: PageProps) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const secondRef = useRef<HTMLInputElement>(null);
  useFocusTrap(dialogRef, {
    active: open,
    onEscape: () => setOpen(false),
    initialFocusRef: startOnSecond ? secondRef : undefined,
    returnFocus,
  });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button">Outside</button>
      {open && (
        <div ref={dialogRef} role="dialog" aria-label="Test dialog">
          <p>Some text</p>
          <button type="button" onClick={() => setOpen(false)}>
            First
          </button>
          <input aria-label="Second" ref={secondRef} />
          <a href="#last">Last</a>
        </div>
      )}
    </>
  );
}

async function openPage(props: PageProps = {}) {
  const user = userEvent.setup();
  const view = render(<Page {...props} />);
  await user.click(screen.getByRole('button', { name: 'Open' }));
  return { user, ...view };
}

describe('useFocusTrap', () => {
  it('moves focus to the first control on open', async () => {
    await openPage();
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  });

  it('moves focus to the initial control when one is given', async () => {
    await openPage({ startOnSecond: true });
    expect(screen.getByLabelText('Second')).toHaveFocus();
  });

  it('wraps Tab from the last control and Shift+Tab from the first', async () => {
    const { user } = await openPage();
    const first = screen.getByRole('button', { name: 'First' });
    const last = screen.getByRole('link', { name: 'Last' });

    await user.tab();
    await user.tab();
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it('brings focus back from <body> on the next Tab', async () => {
    const { user } = await openPage();
    act(() => (document.activeElement as HTMLElement).blur());
    expect(document.body).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  });

  it('pulls focus back in when the page moves it out', async () => {
    await openPage({ startOnSecond: true });
    act(() => screen.getByRole('button', { name: 'Outside' }).focus());
    expect(screen.getByLabelText('Second')).toHaveFocus();
  });

  it('closes on Escape and hands focus back to the opener', async () => {
    const { user } = await openPage();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
  });

  it('hands focus to what returnFocus picks, given the opener', async () => {
    const returnFocus = jest.fn(() => screen.getByRole('button', { name: 'Outside' }));
    const { user } = await openPage({ returnFocus });
    await user.click(screen.getByRole('button', { name: 'First' }));
    expect(returnFocus).toHaveBeenCalledWith(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('button', { name: 'Outside' })).toHaveFocus();
  });

  it('leaves focus alone after closing', async () => {
    const { user } = await openPage();
    await user.keyboard('{Escape}');
    act(() => screen.getByRole('button', { name: 'Outside' }).focus());
    expect(screen.getByRole('button', { name: 'Outside' })).toHaveFocus();
  });

  it('focuses nothing when the page unmounts with the dialog open', async () => {
    const returnFocus = jest.fn(() => null);
    const { unmount } = await openPage({ returnFocus });
    unmount();
    expect(returnFocus).not.toHaveBeenCalled();
  });
});
