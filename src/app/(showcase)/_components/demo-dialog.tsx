'use client';

import { Fragment, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Mark } from './mark';
import { Modal } from './modal';

/**
 * How to get into the demo (docs/local.md §18.2): the published viewer sign-in, and the ushers'
 * code for the scanner. The passwords are environment values the owner chose; where one is unset
 * the page points at the README instead of showing a blank.
 */
export type DemoAccess = {
  signInPath: string;
  scannerPath: string;
  viewerEmail: string;
  viewerPassword: string | null;
  ushers: readonly string[];
  usherCode: string | null;
  readmeUrl: string;
};

export function DemoDialog({ open, onClose, demo }: { open: boolean; onClose: () => void; demo: DemoAccess }) {
  return (
    <Modal open={open} onClose={onClose} label="Sign in to the demo" panelClassName="zx-pass">
      <div className="zx-pass__body">
        <p className="zx-pass__show">
          <Mark className="zx-pass__mark" />
          Autumn Serenade, the demo concert
        </p>
        <h2 className="zx-pass__title">Sign in as a viewer</h2>
        <p className="zx-pass__lead">
          Every screen of a fictional concert, read-only: you can look at everything and change nothing.
          It resets every Monday.
        </p>

        <dl className="zx-pass__creds">
          <div>
            <dt>Email</dt>
            <dd>
              <code>{demo.viewerEmail}</code>
              <CopyButton value={demo.viewerEmail} label="email" />
            </dd>
          </div>
          <div>
            <dt>Password</dt>
            <dd>
              {demo.viewerPassword ? (
                <>
                  <code>{demo.viewerPassword}</code>
                  <CopyButton value={demo.viewerPassword} label="password" />
                </>
              ) : (
                <a href={demo.readmeUrl}>In the README</a>
              )}
            </dd>
          </div>
        </dl>

        <a className="zx-btn zx-btn--primary zx-pass__go" href={demo.signInPath}>
          Continue to sign-in
        </a>

        {demo.usherCode && (
          <p className="zx-pass__ushers">
            The door is open too. On a phone, ushers sign in at <code>{demo.scannerPath}</code> as{' '}
            {demo.ushers.map((usher, index) => (
              <Fragment key={usher}>
                {index === 0 ? '' : index === demo.ushers.length - 1 ? ' or ' : ', '}
                <b>{usher}</b>
              </Fragment>
            ))}{' '}
            with the code <code>{demo.usherCode}</code>.
          </p>
        )}
      </div>
      <div className="zx-pass__stub" aria-hidden>
        <span>Admit one</span>
      </div>
    </Modal>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="zx-copy"
      aria-label={copied ? `Copied the ${label}` : `Copy the ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          // Clipboard refused (an insecure origin, or permission): the value is on screen to select.
        }
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
    </button>
  );
}
