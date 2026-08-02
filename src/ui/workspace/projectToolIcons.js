import {
  Bug,
  ClipboardList,
  FileText,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  PackageCheck,
  PanelsTopLeft,
  ScanSearch,
  Tags,
} from 'lucide-react';

const PROJECT_TOOL_ICONS = Object.freeze({
  Bug,
  ClipboardList,
  FileText,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  PackageCheck,
  ScanSearch,
  Tags,
});

export function getProjectToolIcon(iconKey) {
  return PROJECT_TOOL_ICONS[String(iconKey || '').trim()] || PanelsTopLeft;
}

export function hasProjectToolIcon(iconKey) {
  return Object.prototype.hasOwnProperty.call(
    PROJECT_TOOL_ICONS,
    String(iconKey || '').trim(),
  );
}
