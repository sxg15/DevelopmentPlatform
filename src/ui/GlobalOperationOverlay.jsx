import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle } from 'lucide-react';
import {
  getGlobalOperationSnapshot,
  subscribeGlobalOperation,
} from '../api/requestActivity.js';
import { acquirePageInteractionLock } from './pageInteractionLock.js';

const OVERLAY_EXIT_DURATION_MS = 180;

export function GlobalOperationOverlay() {
  const operation = useSyncExternalStore(
    subscribeGlobalOperation,
    getGlobalOperationSnapshot,
    getGlobalOperationSnapshot,
  );
  const overlayRef = useRef(null);
  const exitTimerRef = useRef(null);
  const animationFrameRef = useRef([]);
  const [shouldRender, setShouldRender] = useState(operation.active);
  const [isVisible, setIsVisible] = useState(false);
  const [displayMessage, setDisplayMessage] = useState(operation.message);

  useEffect(() => {
    clearPendingTransition();

    if (operation.active) {
      setDisplayMessage(operation.message);
      setShouldRender(true);
      animationFrameRef.current.push(window.requestAnimationFrame(() => {
        animationFrameRef.current.push(window.requestAnimationFrame(() => {
          setIsVisible(true);
        }));
      }));
    } else if (shouldRender) {
      setIsVisible(false);
      exitTimerRef.current = setTimeout(() => {
        setShouldRender(false);
        exitTimerRef.current = null;
      }, getOverlayExitDuration());
    }

    return clearPendingTransition;
  }, [operation.active, operation.message, shouldRender]);

  useEffect(() => {
    if (!shouldRender) {
      return undefined;
    }

    return acquirePageInteractionLock(() => overlayRef.current);
  }, [shouldRender]);

  if (!shouldRender) {
    return null;
  }

  return createPortal(
    <div
      ref={overlayRef}
      className={`global-operation-backdrop ${isVisible ? 'is-visible' : 'is-exiting'}`}
      role="alertdialog"
      aria-modal="true"
      aria-busy="true"
      aria-label="操作中"
      tabIndex={-1}
    >
      <div className="global-operation-indicator">
        <LoaderCircle aria-hidden="true" />
        <div>
          <strong>操作中</strong>
          <span>{displayMessage}</span>
        </div>
      </div>
    </div>,
    document.body,
  );

  function clearPendingTransition() {
    for (const frameId of animationFrameRef.current) {
      window.cancelAnimationFrame(frameId);
    }
    animationFrameRef.current = [];
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
  }
}

function getOverlayExitDuration() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 1
    : OVERLAY_EXIT_DURATION_MS;
}
