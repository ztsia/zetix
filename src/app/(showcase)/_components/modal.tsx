'use client';

import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A native `<dialog>`, for its focus trap, Escape and inert page, with Motion for the entrance and
 * the exit. Closing runs the exit first and only then closes the dialog, so the panel leaves the
 * way it came; focus goes back to whatever opened it.
 */
export function Modal({
  open,
  onClose,
  label,
  panelClassName,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  panelClassName?: string;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
    }
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="zx-modal"
      aria-label={label}
      data-lenis-prevent
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <AnimatePresence
        onExitComplete={() => {
          dialog.current?.close();
          opener.current?.focus();
        }}
      >
        {open && (
          <motion.div
            key="frame"
            className="zx-modal__frame"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="zx-modal__scrim" aria-hidden onClick={onClose} />
            <motion.div
              className={cn('zx-modal__panel', panelClassName)}
              initial={{ opacity: 0, y: 28, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 14, scale: 0.98 }}
              transition={{ type: 'spring', bounce: 0.16, visualDuration: 0.45 }}
            >
              <button type="button" className="zx-modal__close" onClick={onClose} aria-label="Close">
                <X aria-hidden />
              </button>
              {children}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </dialog>
  );
}
