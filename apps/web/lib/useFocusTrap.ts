'use client';

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** Focusable descendants, in DOM order: the set the trap cycles through. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface FocusTrapOptions {
  /** Whether the dialog is open. The trap acts only while this is true. */
  active: boolean;
  /** Called on Escape. */
  onEscape: () => void;
  /** Where focus goes on open, and back to when the page moves it out. Defaults to the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Where focus goes on close, given the element focused when the dialog opened.
   * Defaults to that element. Nothing is focused if the result has left the page.
   */
  returnFocus?: (opener: HTMLElement | null) => HTMLElement | null | undefined;
}

/**
 * Modal focus for a hand-written dialog: Jest's jsdom has no `showModal`, so the app's
 * dialogs are plain elements with `role="dialog"` and this supplies what a native modal
 * would. While `active`, it moves focus in, wraps Tab and Shift+Tab, brings focus back
 * from `<body>` on the next Tab, pulls focus back when the page moves it out, and closes
 * on Escape. When `active` turns false, it hands focus back.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  { active, onEscape, initialFocusRef, returnFocus }: FocusTrapOptions,
): void {
  // Read through a ref, so a caller passing new callbacks each render doesn't re-run the
  // effect, which would move focus back to the start on every render. Updated in an effect
  // rather than during render, declared before the trap's effect so it runs first.
  const optionsRef = useRef({ onEscape, initialFocusRef, returnFocus });
  useEffect(() => {
    optionsRef.current = { onEscape, initialFocusRef, returnFocus };
  });

  // Declared before the trap's effect, so on unmount this cleanup runs first and the
  // trap's cleanup can tell an unmount from a close.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusable = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
    // preventScroll: Back can land while the dialog is open, and scrolling to the focused
    // control would cancel the page's scroll restoration.
    const focusStart = () =>
      (optionsRef.current.initialFocusRef?.current ?? focusable()[0])?.focus({
        preventScroll: true,
      });

    focusStart();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        optionsRef.current.onEscape();
        return;
      }
      if (event.key !== 'Tab') return;

      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) return;

      const current = document.activeElement;
      // A click on the dialog's text leaves focus on <body>, outside the dialog.
      if (!container.contains(current)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // The page can move focus on its own, such as another component focusing a control as
    // it mounts.
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !container.contains(event.target)) focusStart();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      // Leaving the page isn't closing the dialog: focusing something then would fight the
      // next page's own focus and scroll handling.
      if (!mountedRef.current) return;
      const { returnFocus: pick } = optionsRef.current;
      const target = pick ? pick(opener) : opener;
      if (target?.isConnected) target.focus();
    };
  }, [active, containerRef]);
}
