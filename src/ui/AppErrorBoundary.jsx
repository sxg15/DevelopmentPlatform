import { Component } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { createClientDiagnosticId } from '../../shared/clientErrorUtils.js';
import { reportClientError } from '../api/clientErrors.js';

export class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = {
      error: null,
      diagnosticId: '',
    };
  }

  static getDerivedStateFromError(error) {
    return {
      error,
      diagnosticId: createClientDiagnosticId(),
    };
  }

  componentDidCatch(error, errorInfo) {
    void reportClientError(error, {
      source: 'react-error-boundary',
      diagnosticId: this.state.diagnosticId,
      componentStack: errorInfo?.componentStack || '',
    });
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <main className="app-shell app-error-shell" aria-label="页面运行异常">
        <header className="top-toolbar">
          <div className="toolbar-title">开发平台</div>
          <div className="toolbar-user">
            <span className="toolbar-user-placeholder">运行异常</span>
          </div>
        </header>
        <section className="app-runtime-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <div className="app-runtime-error-content">
            <h1>页面运行异常</h1>
            <p>本次异常已记录，请刷新页面后继续使用。</p>
            <code>错误编号：{this.state.diagnosticId}</code>
          </div>
          <button type="button" onClick={() => window.location.reload()}>
            <RefreshCw aria-hidden="true" />
            刷新页面
          </button>
        </section>
      </main>
    );
  }
}
