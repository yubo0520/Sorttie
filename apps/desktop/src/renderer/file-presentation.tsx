import { useEffect, useRef, useState, type CSSProperties } from "react";
import { registeredFileUrl, type TextPreview } from "../shared/contracts";
import { Icon } from "./Icon";
import type { FileItem, FileKind, FileStatus } from "./types";

export const kindLabels: Record<FileKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  document: "文档",
  code: "代码",
  archive: "压缩包",
  unknown: "文件",
};

export const kindIcons: Record<FileKind, Parameters<typeof Icon>[0]["name"]> = {
  image: "image",
  video: "video",
  audio: "audio",
  document: "file",
  code: "code",
  archive: "archive",
  unknown: "file",
};

export const statusClass: Record<FileStatus, string> = {
  ready: "status-ready",
  modified: "status-modified",
  downloading: "status-info",
  protected: "status-muted",
  conflict: "status-danger",
};

export function isOperable(file: FileItem): boolean {
  return file.isOrganizable;
}

type PreviewMode = "card" | "detail" | "hover";
type AudioPlaybackState = "loading" | "ready" | "playing" | "paused" | "ended" | "error";

function audioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const wholeSeconds = Math.floor(seconds);
  return `${String(Math.floor(wholeSeconds / 60)).padStart(2, "0")}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

function DetailAudioPlayer({ file, previewClass, onFailure }: { file: FileItem; previewClass: string; onFailure: () => void }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playbackState, setPlaybackState] = useState<AudioPlaybackState>("loading");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    setPlaybackState("loading");
    setCurrentTime(0);
    setDuration(0);
    return () => {
      audioRef.current?.pause();
    };
  }, [file.id, file.modifiedAt]);

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio || playbackState === "loading" || playbackState === "error") return;
    if (playbackState === "playing") {
      audio.pause();
      return;
    }
    if (playbackState === "ended" || audio.ended || audio.currentTime >= duration) {
      audio.currentTime = 0;
      setCurrentTime(0);
    }
    void audio.play().catch(() => {
      setPlaybackState("error");
      onFailure();
    });
  };

  const seek = (value: number) => {
    const audio = audioRef.current;
    if (!audio || duration <= 0) return;
    audio.currentTime = Math.min(duration, Math.max(0, value));
    setCurrentTime(audio.currentTime);
    if (playbackState === "ended") setPlaybackState("paused");
  };

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const unavailable = playbackState === "loading" || playbackState === "error" || duration <= 0;
  return (
    <div className={`${previewClass} real-audio-preview`} data-preview-capability="audio" data-playback-state={playbackState}>
      <audio
        ref={audioRef}
        src={registeredFileUrl(file.id)}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const nextDuration = event.currentTarget.duration;
          if (!Number.isFinite(nextDuration) || nextDuration <= 0) return;
          setDuration(nextDuration);
          setPlaybackState("ready");
        }}
        onPlay={() => setPlaybackState("playing")}
        onPause={() => setPlaybackState((current) => current === "ended" || current === "error" ? current : "paused")}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onEnded={(event) => {
          setCurrentTime(event.currentTarget.duration);
          setPlaybackState("ended");
        }}
        onError={() => {
          setPlaybackState("error");
          onFailure();
        }}
      />
      <span className="audio-kind-icon" aria-hidden="true"><Icon name="audio" /></span>
      <div className="audio-controls">
        <button
          type="button"
          className="audio-play-button"
          aria-label={playbackState === "playing" ? "暂停" : "播放"}
          disabled={unavailable}
          onClick={togglePlayback}
        >
          {playbackState === "playing" ? <span className="pause-glyph" /> : <span className="play-glyph" />}
        </button>
        <time>{audioTime(currentTime)}</time>
        <input
          type="range"
          min="0"
          max={duration || 0}
          step="0.1"
          value={Math.min(currentTime, duration || 0)}
          disabled={unavailable}
          aria-label={`音频进度，当前 ${audioTime(currentTime)}，总时长 ${audioTime(duration)}`}
          onChange={(event) => seek(Number(event.currentTarget.value))}
          style={{ "--audio-progress": `${progress}%` } as CSSProperties}
        />
        <time>{audioTime(duration)}</time>
      </div>
      <span className="format-mark">{file.extension ? file.extension.slice(1).toUpperCase() : "AUDIO"}</span>
    </div>
  );
}

function PreviewFallback({ file, previewClass, minimal = false }: { file: FileItem; previewClass: string; minimal?: boolean }) {
  if (minimal) return <span className="hover-preview-message" data-preview-capability="unsupported">此文件暂不支持预览</span>;
  const format = file.extension ? file.extension.slice(1).toUpperCase() : "FILE";
  return (
    <div className={previewClass} aria-label={`${kindLabels[file.kind]}预览不可用`} data-preview-capability="unsupported">
      <span className="large-file-icon"><Icon name={kindIcons[file.kind]} /></span>
      <span className="format-mark">{format}</span>
      <span className="archive-meta">{kindLabels[file.kind]} · {file.size}</span>
    </div>
  );
}

// Mounted only for a hovered file: one media element, no controls or background playback.
function HoverMedia({ file, onSize }: { file: FileItem; onSize?: (width: number, height: number) => void }) {
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const video = file.previewCapability === "video";
  useEffect(() => {
    if (failed) return;
    const media = mediaRef.current!;
    let active = true;
    let boundaryTimer: number | undefined;
    const fail = () => { if (active) setFailed(true); };
    const play = () => {
      void media.play().then(() => { if (!active) media.pause(); }).catch(fail);
    };
    const repeat = () => {
      window.clearTimeout(boundaryTimer);
      if (!active) return;
      media.currentTime = 0;
      play();
    };
    const scheduleBoundary = () => {
      window.clearTimeout(boundaryTimer);
      if (!active || media.paused || media.seeking) return;
      const end = Math.min(10, Number.isFinite(media.duration) ? media.duration : 10);
      const remaining = end - media.currentTime;
      if (remaining <= 0) repeat();
      else boundaryTimer = window.setTimeout(scheduleBoundary, remaining * 1000 + 10);
    };
    media.addEventListener("playing", scheduleBoundary);
    media.addEventListener("timeupdate", scheduleBoundary);
    media.addEventListener("seeked", scheduleBoundary);
    media.addEventListener("ended", repeat);
    play();
    return () => {
      active = false;
      window.clearTimeout(boundaryTimer);
      media.removeEventListener("playing", scheduleBoundary);
      media.removeEventListener("timeupdate", scheduleBoundary);
      media.removeEventListener("seeked", scheduleBoundary);
      media.removeEventListener("ended", repeat);
      media.pause();
      media.removeAttribute("src");
      media.load();
    };
  }, [file.id, failed]);
  if (failed) return <span className="hover-preview-message" data-preview-capability="unsupported">此文件暂不支持预览</span>;
  const Media = video ? "video" : "audio";
  return <div className="file-preview preview-mode-hover" data-preview-capability={file.previewCapability}>
    <Media ref={mediaRef} src={registeredFileUrl(file.id)} preload="metadata"
      onLoadedMetadata={(event) => {
        if (video) {
          const media = event.currentTarget as HTMLVideoElement;
          onSize?.(media.videoWidth, media.videoHeight);
        }
      }} onPlaying={() => setPlaying(true)} onError={() => setFailed(true)} />
    {!video && <span className="hover-audio-status" role="status">{playing ? "正在试听" : "正在加载…"}</span>}
  </div>;
}

function PreviewRenderer({ file, mode, onSize }: { file: FileItem; mode: PreviewMode; onSize?: (width: number, height: number) => void }) {
  const previewClass = `file-preview preview-${file.kind}${mode !== "card" ? " preview-compact" : ""} preview-mode-${mode}`;
  const format = file.extension ? file.extension.slice(1).toUpperCase() : "FILE";
  const [failed, setFailed] = useState(false);
  const [textPreview, setTextPreview] = useState<TextPreview | null | undefined>(undefined);

  useEffect(() => {
    setFailed(false);
    setTextPreview(undefined);
  }, [file.id, file.modifiedAt, mode]);

  useEffect(() => {
    if (file.previewCapability !== "text" || mode === "card") return;
    let active = true;
    void window.sorttie?.readTextPreview(file.id)
      .then((value) => { if (active) setTextPreview(value); })
      .catch(() => { if (active) setTextPreview(null); });
    return () => { active = false; };
  }, [file.id, file.previewCapability, mode]);

  if (failed) return <PreviewFallback file={file} previewClass={previewClass} minimal={mode === "hover"} />;
  if (mode === "hover" && ["audio", "video"].includes(file.previewCapability)) return <HoverMedia file={file} onSize={onSize} />;
  if (file.previewCapability === "image" && file.thumbnailUrl) {
    return (
      <div className={previewClass} aria-label="真实图片预览" data-preview-capability="image">
        <img src={file.thumbnailUrl} alt="" onLoad={(event) => onSize?.(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} onError={() => setFailed(true)} />
        {mode !== "hover" && <span className="format-mark">{format}</span>}
      </div>
    );
  }
  if (file.previewCapability === "video" && mode !== "card") {
    return (
      <div className={previewClass} data-preview-capability="video">
        <video src={registeredFileUrl(file.id)} controls preload="metadata" onError={() => setFailed(true)} />
        <span className="format-mark">{format}</span>
      </div>
    );
  }
  if (file.previewCapability === "audio" && mode !== "card") {
    return <DetailAudioPlayer file={file} previewClass={previewClass} onFailure={() => setFailed(true)} />;
  }
  if (file.previewCapability === "pdf" && mode !== "card") {
    return (
      <div className={`${previewClass} real-pdf-preview`} data-preview-capability="pdf">
        <iframe src={`${registeredFileUrl(file.id)}${mode === "hover" ? "#page=1&toolbar=0&navpanes=0&view=FitH" : ""}`} title={`${file.name} 第一页预览`} loading="lazy" tabIndex={mode === "hover" ? -1 : undefined} />
        {mode !== "hover" && <span className="format-mark">PDF</span>}
      </div>
    );
  }
  if (file.previewCapability === "text" && mode !== "card") {
    if (textPreview === null) return <PreviewFallback file={file} previewClass={previewClass} minimal={mode === "hover"} />;
    return (
      <div className={`${previewClass} real-text-preview`} data-preview-capability="text">
        {textPreview ? <pre>{textPreview.text}</pre> : <span className="preview-loading">正在读取预览…</span>}
        {mode !== "hover" && textPreview?.truncated && <span className="preview-truncated">仅显示前 64 KB</span>}
        {mode !== "hover" && <span className="format-mark">{format}</span>}
      </div>
    );
  }
  return <PreviewFallback file={file} previewClass={previewClass} minimal={mode === "hover"} />;
}

export function FilePreview({ file, compact = false, hover = false, onSize }: { file: FileItem; compact?: boolean; hover?: boolean; onSize?: (width: number, height: number) => void }) {
  return <PreviewRenderer key={hover ? `${file.id}:${file.modifiedAt}:${file.sizeBytes}` : undefined} file={file} mode={hover ? "hover" : compact ? "detail" : "card"} onSize={onSize} />;
}

// Card bodies are mounted only while visible. They use registered IDs, never paths.
// Hover remains a separate renderer with its existing lifecycle and controls.
export function FileCardPreview({ file }: { file: FileItem }) {
  const [text, setText] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setText(null); setFailed(false); setDuration(0);
    if (file.previewCapability === "text") {
      void window.sorttie?.readTextPreview(file.id).then((value) => { if (active) { setText(value?.text ?? null); setFailed(value == null); } }).catch(() => { if (active) setFailed(true); });
    }
    return () => { active = false; };
  }, [file.id, file.modifiedAt, file.sizeBytes, file.previewCapability]);
  if (failed) return <span className="card-type-fallback"><Icon name={kindIcons[file.kind]} /><small>预览暂不可用</small></span>;
  if (file.previewCapability === "image" && file.thumbnailUrl) return <img src={file.thumbnailUrl} alt="" onError={() => setFailed(true)} />;
  if (file.previewCapability === "video") return <span className="card-video-body"><video muted preload="metadata" src={registeredFileUrl(file.id)} onError={() => setFailed(true)} onLoadedMetadata={(event) => { setDuration(event.currentTarget.duration); event.currentTarget.currentTime = Math.min(.05, event.currentTarget.duration || 0); }} /><span className="card-play"><Icon name="play" /></span>{duration > 0 && <time>{audioTime(duration)}</time>}</span>;
  if (file.previewCapability === "audio") return <span className="card-audio-body"><audio preload="metadata" src={registeredFileUrl(file.id)} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} onError={() => setFailed(true)} /><span className="card-audio-placeholder"><Icon name="audio" /><small>悬停试听</small></span><span className="card-audio-meta"><Icon name="play" /><span>{audioTime(duration || NaN)}</span></span></span>;
  if (file.previewCapability === "text") return <span className={`card-text-body ${file.kind === "code" ? "is-code" : "is-document"}`}><pre>{text?.slice(0, 2000) ?? "正在读取…"}</pre></span>;
  if (file.previewCapability === "pdf") return <span className="card-pdf-body"><iframe title={`${file.name} 卡片预览`} src={`${registeredFileUrl(file.id)}#page=1&toolbar=0&navpanes=0&view=FitH`} tabIndex={-1} /></span>;
  return <span className="card-type-fallback"><Icon name={kindIcons[file.kind]} /><span>{kindLabels[file.kind]}<small>{file.extension || "未知格式"}</small></span></span>;
}
