import type { Category, FileKind, FileRecord, FileStatus } from "../shared/contracts";

export type { Category, FileKind, FileStatus } from "../shared/contracts";

export type Activity = {
  action: string;
  time: string;
  location: string;
  verified: boolean;
};

export type FileItem = FileRecord & {
  path: string;
  size: string;
  modified: string;
  statusLabel: string;
  suggestedFolder: string;
  activity: Activity[];
  thumbnailUrl?: string | null;
};

const statusLabels: Record<FileStatus, string> = {
  ready: "可整理",
  modified: "已修改分类",
  downloading: "下载中",
  protected: "受保护",
  conflict: "存在冲突",
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function toFileItem(record: FileRecord, thumbnailUrl?: string | null): FileItem {
  const activityLabel = record.lastActivityKind === "created" ? "新建文件" : record.lastActivityKind === "modified" ? "最近修改" : "最近变化";
  return {
    ...record,
    path: record.absolutePath,
    size: formatBytes(record.sizeBytes),
    modified: formatTimestamp(record.modifiedAt),
    statusLabel: statusLabels[record.status],
    suggestedFolder: `按“${record.category}”分类（尚未设置目标目录）`,
    activity: [
      { action: "首次发现", time: formatTimestamp(record.firstDiscoveredAt), location: record.parentDirectory, verified: true },
      { action: activityLabel, time: formatTimestamp(new Date(record.lastActivityAt).toISOString()), location: record.parentDirectory, verified: true },
      { action: "来源应用", time: "未验证", location: "没有可验证的应用证据", verified: false },
    ],
    thumbnailUrl,
  };
}
