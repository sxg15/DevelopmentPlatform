import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle } from 'lucide-react';
import {
  getGlobalOperationSnapshot,
  subscribeGlobalOperation,
} from '../api/requestActivity.js';
import { acquirePageInteractionLock } from './pageInteractionLock.js';

export function GlobalOperationOverlay() {
  const operation = useSyncExternalStore(
    subscribeGlobalOperation,
    getGlobalOperationSnapshot,
    getGlobalOperationSnapshot,
  );
  const overlayRef = useRef(null);

  useEffect(() => {
    if (!operation.active) {
      return undefined;
    }

    return acquirePageInteractionLock(() => overlayRef.current);
  }, [operation.active]);

  if (!operation.active) {
    return null;
  }

  return createPortal(
    <div
      ref={overlayRef}
      className="global-operation-backdrop"
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
          <span>{operation.message}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
