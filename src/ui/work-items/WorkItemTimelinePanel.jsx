import { Component, lazy, Suspense } from 'react';
import { AlertTriangle, History } from 'lucide-react';
import { createClientDiagnosticId } from '../../../shared/clientErrorUtils.js';
import { reportClientError } from '../../api/clientErrors.js';

const WorkItemTimeline = lazy(() => import('./WorkItemTimeline.jsx'));

export function WorkItemTimelinePanel(props) {
  return (
    <WorkItemTimelineErrorBoundary recordId={props.record?.recordId}>
      <Suspense fallback={<WorkItemTimelineLoading />}>
        <WorkItemTimeline {...props} />
      </Suspense>
    </WorkItemTimelineErrorBoundary>
  );
}

class WorkItemTimelineErrorBoundary extends Component {
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
      source: 'work-item-timeline-error-boundary',
      diagnosticId: this.state.diagnosticId,
      componentStack: errorInfo?.componentStack || '',
    });
  }

  componentDidUpdate(previousProps) {
    if (this.state.error && previousProps.recordId !== this.props.recordId) {
      this.setState({ error: null, diagnosticId: '' });
    }
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <section className="work-item-timeline work-item-timeline-fallback" aria-label="时间轴" role="alert">
        <AlertTriangle aria-hidden="true" />
        <div>
          <strong>时间轴暂时无法显示</strong>
          <p>详情和操作功能不受影响，可刷新页面后重试。</p>
        </div>
      </section>
    );
  }
}

function WorkItemTimelineLoading() {
  return (
    <section className="work-item-timeline work-item-timeline-loading" aria-label="正在加载时间轴" aria-busy="true">
      <History aria-hidden="true" />
      <span>正在加载时间轴</span>
    </section>
  );
}
