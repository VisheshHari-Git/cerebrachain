import { useEffect, useRef, useState } from "react";
import App from "./App";
import LiveVerificationDashboard from "./components/LiveVerificationDashboard";
import "./VerificationShell.css";

/**
 * Non-invasive integration:
 * - Existing App is rendered unchanged.
 * - Verification dashboard opens only when requested.
 * - No private model data is exposed.
 */
export default function VerificationShell() {
  const [open, setOpen] = useState(false);

  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;

    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const frame = window.requestAnimationFrame(() => {
      closeRef.current?.focus();
    });

    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", onEscape);

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onEscape);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [open]);

  return (
    <>
      {/* Original Figma-style application remains unchanged. */}
      <App />

      <button
        type="button"
        className="cc-live-launcher"
        onClick={() => setOpen(true)}
        aria-label="Open Live Verification Dashboard"
        aria-expanded={open}
        aria-controls="cc-live-verification-panel"
      >
        <span className="cc-live-launcher__icon" aria-hidden="true">
          ◈
        </span>
        <span>Live Verification</span>
      </button>

      {open && (
        <div
          className="cc-live-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setOpen(false);
            }
          }}
        >
          <section
            id="cc-live-verification-panel"
            ref={panelRef}
            className="cc-live-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Live Verification Dashboard"
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;

              const focusable = Array.from(
                panelRef.current?.querySelectorAll<HTMLElement>(
                  'button:not([disabled]), a[href], ' +
                  '[tabindex]:not([tabindex="-1"])'
                ) ?? []
              ).filter(element => element.getClientRects().length > 0);

              if (focusable.length === 0) {
                event.preventDefault();
                return;
              }

              const first = focusable[0];
              const last = focusable[focusable.length - 1];

              if (
                event.shiftKey &&
                document.activeElement === first
              ) {
                event.preventDefault();
                last.focus();
              } else if (
                !event.shiftKey &&
                document.activeElement === last
              ) {
                event.preventDefault();
                first.focus();
              }
            }}
          >
            <div className="cc-live-panel__toolbar">
              <div className="cc-live-panel__brand">
                <span className="cc-live-panel__indicator" />
                ZKP-CerebraChain
              </div>

              <button
                ref={closeRef}
                type="button"
                className="cc-live-panel__close"
                onClick={() => setOpen(false)}
                aria-label="Close verification dashboard"
              >
                ✕ Close
              </button>
            </div>

            <div className="cc-live-panel__content">
              <LiveVerificationDashboard />
            </div>
          </section>
        </div>
      )}
    </>
  );
}
