import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export function Modal({ heading, children, onCancel, busy = false, fallbackFocus }: {
  heading: string; children: ReactNode; onCancel: () => void; busy?: boolean;
  fallbackFocus?: () => HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('input, textarea, button, select')?.focus();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else fallbackFocus?.()?.focus();
    };
  }, []);
  return <dialog ref={ref} aria-label={heading} aria-busy={busy} onCancel={(event) => {
    event.preventDefault();
    if (!busy) onCancel();
  }} onKeyDown={(event) => {
    if (event.key !== 'Tab') return;
    const controls = event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
    );
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) event.preventDefault();
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}>
    <h2>{heading}</h2>
    {children}
  </dialog>;
}
