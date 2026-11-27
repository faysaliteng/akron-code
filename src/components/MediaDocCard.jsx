import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';

const MEDIA_DOC_FILE_RE = /(?:^|[\s"'`(])([^\s"'`()<>]+\.(?:png|jpe?g|webp|gif|svg|mp4|webm|mov|mp3|wav|ogg|m4a|pdf|docx|xlsx|xls|csv|pptx|zip|tar\.gz|tgz))(?=$|[\s"'`),.;!?])/gi;
const STUDIO_TOOLS = new Set([
  'GenerateImage', 'create_image',
  'EditImage', 'edit_image',
  'GenerateVideo', 'generate_video',
  'EditVideo', 'edit_video',
  'GenerateDocument', 'ReadDocument',
]);

function classifyExt(filePath) {
  const lower = String(filePath || '').toLowerCase();
  if (/\.(png|jpe?g|webp|gif|svg|bmp|ico)$/.test(lower)) return 'image';
  if (/\.(mp4|webm|mov)$/.test(lower)) return 'video';
  if (/\.(mp3|wav|ogg|m4a|flac)$/.test(lower)) return 'audio';
  if (/\.(xlsx|xls|xlsm|csv|tsv|ods)$/.test(lower)) return 'spreadsheet';
  if (/\.pdf$/.test(lower)) return 'pdf';
  if (/\.docx$/.test(lower)) return 'docx';
  if (/\.pptx$/.test(lower)) return 'pptx';
  if (/\.(zip|tar\.gz|tgz)$/.test(lower)) return 'archive';
  return 'document';
}

export function extractMediaDocTargets({ tools = [], content = '' } = {}) {
  const seen = new Set();
  const out = [];
  const pushPath = (p, hintTool = '') => {
    const clean = String(p || '').trim().replace(/^file:\/\//, '');
    if (!clean || /^https?:\/\//i.test(clean) || /^data:/i.test(clean)) return;
    if (seen.has(clean)) return;
    seen.add(clean);
    out.push({ path: clean, kind: classifyExt(clean), hintTool });
  };

  for (const t of tools || []) {
    if (!t) continue;
    const name = String(t.name || '');
    const args = t.args || {};
    if (STUDIO_TOOLS.has(name)) {
      if (args.output_path) pushPath(args.output_path, name);
      if (args.path) pushPath(args.path, name);
      if (t.result && typeof t.result === 'string') {
        try {
          const parsed = JSON.parse(t.result);
          if (parsed && parsed.path) pushPath(parsed.path, name);
          if (parsed && parsed.contact_sheet) pushPath(parsed.contact_sheet, name);
          if (Array.isArray(parsed && parsed.files)) parsed.files.forEach((f) => pushPath(f, name));
        } catch (_) {
          let m;
          const re = new RegExp(MEDIA_DOC_FILE_RE.source, 'gi');
          while ((m = re.exec(t.result))) pushPath(m[1], name);
        }
      }
    } else if (name === 'Write' && args.path) {
      if (/\.(svg|csv|pdf|docx|xlsx|pptx|zip)$/i.test(args.path)) pushPath(args.path, name);
    }
  }

  if (typeof content === 'string' && content) {
    let m;
    const re = new RegExp(MEDIA_DOC_FILE_RE.source, 'gi');
    while ((m = re.exec(content))) {
      // Only surface explicit paths with a slash or generated output names so generic prose like `logo.png` without location doesn't spam.
      if (m[1].includes('/') || m[1].includes('\\')) pushPath(m[1]);
    }
  }
  return out.slice(0, 8);
}

export function MediaDocCard({ target, cwd, onPromptAction, onOpenInIde }) {
  const [info, setInfo] = useState(null);
  const [status, setStatus] = useState('');
  const [zoomOpen, setZoomOpen] = useState(false);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [slideIdx, setSlideIdx] = useState(0);
  const [showPdfEmbed, setShowPdfEmbed] = useState(false);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDur, setVideoDur] = useState(0);
  const videoRef = useRef(null);

  const filePath = typeof target === 'string' ? target : target.path;
  const kind = (typeof target === 'object' && target.kind) || classifyExt(filePath);
  const fileName = String(filePath || '').split(/[\\/]/).pop() || filePath;

  const inspect = () => {
    if (!window.autobot || typeof window.autobot.studioInspect !== 'function') return;
    window.autobot.studioInspect({ path: filePath, cwd }).then((r) => {
      if (r && r.ok) setInfo(r);
    }).catch(() => {});
  };

  useEffect(() => {
    inspect();
  }, [filePath, cwd]);

  const runAction = async (action, extra = {}) => {
    if (!window.autobot || typeof window.autobot.studioAction !== 'function') return;
    setStatus('Working…');
    try {
      const r = await window.autobot.studioAction({ action, path: filePath, cwd, ...extra });
      if (r && r.canceled) { setStatus(''); return; }
      if (r && r.ok) {
        setStatus(r.path ? `Saved: ${r.path.split(/[\\/]/).pop()}` : 'Done');
        if (r.path && onPromptAction && action !== 'saveAs' && action !== 'reveal') {
          onPromptAction(`Created ${r.path}`);
        }
      } else {
        setStatus((r && r.error) || 'Failed');
      }
    } catch (e) {
      setStatus(e && e.message ? e.message : 'Error');
    }
  };

  const extLabel = (fileName.split('.').pop() || kind).toUpperCase();
  const sizeLabel = info && info.size ? `${Math.round(info.size / 1024) || 1} KB` : '';

  return (
    <div className="media-doc-card" data-media-kind={kind}>
      <div className="media-doc-head">
        <div className="media-doc-title-wrap">
          <span className="media-doc-badge">{extLabel}</span>
          <span className="media-doc-title" title={filePath}>{fileName}</span>
        </div>
        <span className="media-doc-meta">
          {info && info.width && info.height ? `${info.width}×${info.height} · ` : ''}
          {info && info.pageCount ? `${info.pageCount}p · ` : ''}
          {info && info.slideCount ? `${info.slideCount} slides · ` : ''}
          {info && info.duration ? `${info.duration.toFixed(1)}s · ` : ''}
          {sizeLabel}
        </span>
      </div>

      {kind === 'image' && info && (info.dataUrl || info.fileUrl) && (
        <div className="media-doc-img-wrap" onClick={() => setZoomOpen(true)} title="Click to zoom">
          <img src={info.dataUrl || info.fileUrl} alt={fileName} />
        </div>
      )}

      {kind === 'video' && (
        <>
          <video
            ref={videoRef}
            className="media-doc-video"
            controls
            playsInline
            src={(info && info.fileUrl) || ('file://' + encodeURI(filePath))}
            onLoadedMetadata={(e) => setVideoDur(e.currentTarget.duration || 0)}
            onTimeUpdate={(e) => setVideoTime(e.currentTarget.currentTime || 0)}
          />
          {videoDur > 0 && (
            <div className="media-doc-scrubber">
              <span>{videoTime.toFixed(1)}s</span>
              <input
                type="range"
                min={0}
                max={videoDur}
                step={0.05}
                value={videoTime}
                onChange={(e) => {
                  const t = Number(e.target.value);
                  setVideoTime(t);
                  if (videoRef.current) videoRef.current.currentTime = t;
                }}
              />
              <span>{videoDur.toFixed(1)}s</span>
            </div>
          )}
        </>
      )}

      {kind === 'audio' && (
        <audio
          className="media-doc-audio"
          controls
          src={(info && info.fileUrl) || ('file://' + encodeURI(filePath))}
        />
      )}

      {kind === 'spreadsheet' && info && Array.isArray(info.sheets) && info.sheets.length > 0 && (
        <>
          {info.sheets.length > 1 && (
            <div className="media-doc-tabs">
              {info.sheets.map((s, idx) => (
                <button key={s.name} type="button" className={'media-doc-tab' + (idx === sheetIdx ? ' on' : '')} onClick={() => setSheetIdx(idx)}>
                  {s.name}
                </button>
              ))}
            </div>
          )}
          {(() => {
            const sh = info.sheets[sheetIdx] || info.sheets[0];
            if (!sh) return null;
            return (
              <div className="media-doc-table-wrap">
                <table className="media-doc-table">
                  {sh.headers && sh.headers.length > 0 && (
                    <thead>
                      <tr>{sh.headers.map((h, i) => <th key={i}>{String(h)}</th>)}</tr>
                    </thead>
                  )}
                  <tbody>
                    {(sh.rows || []).slice(0, 50).map((row, ri) => (
                      <tr key={ri}>{(row || []).map((cell, ci) => <td key={ci}>{String(cell == null ? '' : cell)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })()}
        </>
      )}

      {kind === 'pdf' && info && (
        showPdfEmbed && info.fileUrl ? (
          <iframe className="media-doc-pdf-frame" src={info.fileUrl} title={fileName} />
        ) : (
          <div className="media-doc-preview-box">{String(info.text || info.markdown || '').slice(0, 1200) || '(PDF loaded)'}</div>
        )
      )}

      {kind === 'docx' && info && (
        <div className="media-doc-preview-box">{String(info.markdown || info.text || '').slice(0, 1400)}</div>
      )}

      {kind === 'pptx' && info && Array.isArray(info.slides) && info.slides.length > 0 && (
        <>
          <div className="media-doc-tabs">
            {info.slides.map((s, idx) => (
              <button key={idx} type="button" className={'media-doc-tab' + (idx === slideIdx ? ' on' : '')} onClick={() => setSlideIdx(idx)}>
                Slide {s.slideNumber}
              </button>
            ))}
          </div>
          {(() => {
            const sl = info.slides[slideIdx] || info.slides[0];
            if (!sl) return null;
            return (
              <div className="media-doc-preview-box">
                <strong>{sl.title}</strong>
                {sl.body && sl.body.length > 0 && `\n${sl.body.map((b) => `• ${b}`).join('\n')}`}
                {sl.notes && `\n\nNotes: ${sl.notes}`}
              </div>
            );
          })()}
        </>
      )}

      {kind === 'archive' && info && Array.isArray(info.entries) && (
        <div className="media-doc-preview-box">
          {info.entries.slice(0, 40).map((e) => `${e.isDirectory ? '📁' : '📄'} ${e.path}${e.isDirectory ? '' : ` (${e.size}b)`}`).join('\n')}
        </div>
      )}

      {status && <div className="media-doc-meta">{status}</div>}

      <div className="media-doc-actions">
        {kind === 'image' && (
          <>
            <button type="button" className="media-doc-btn" onClick={() => onPromptAction && onPromptAction(`Edit image ${filePath}: `)}>
              <Icon name="Edit" size={12} /> Edit / Inpaint
            </button>
            <button type="button" className="media-doc-btn" onClick={() => runAction('remove_background')}>Remove BG</button>
            <button type="button" className="media-doc-btn" onClick={() => runAction('upscale')}>Upscale</button>
          </>
        )}
        {kind === 'video' && (
          <>
            <button type="button" className="media-doc-btn" onClick={() => runAction('to_gif')}>Convert to GIF</button>
            <button type="button" className="media-doc-btn" onClick={() => runAction('extract_frames')}>Extract Frames</button>
          </>
        )}
        {kind === 'audio' && (
          <button type="button" className="media-doc-btn" onClick={() => onPromptAction && onPromptAction(`Transcribe audio file ${filePath}`)}>
            Transcribe
          </button>
        )}
        {kind === 'pdf' && (
          <button type="button" className="media-doc-btn" onClick={() => setShowPdfEmbed((v) => !v)}>
            {showPdfEmbed ? 'Text View' : 'PDF Preview'}
          </button>
        )}
        {(kind === 'docx' || kind === 'pptx') && (
          <button type="button" className="media-doc-btn" onClick={() => runAction('export_pdf')}>Export PDF</button>
        )}
        {kind === 'archive' && (
          <button type="button" className="media-doc-btn" onClick={() => runAction('extract_archive')}>Extract to Workspace</button>
        )}
        <button type="button" className="media-doc-btn" onClick={() => runAction('saveAs')}>
          <Icon name="Download" size={12} /> Save As…
        </button>
        <button type="button" className="media-doc-btn" onClick={() => (onOpenInIde ? onOpenInIde(filePath) : runAction('reveal'))}>
          Open in IDE / Finder
        </button>
      </div>

      {zoomOpen && info && (info.dataUrl || info.fileUrl) && (
        <div className="media-doc-lightbox" onClick={() => setZoomOpen(false)}>
          <img src={info.dataUrl || info.fileUrl} alt={fileName} />
          <div className="media-doc-actions" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="media-doc-btn" onClick={() => runAction('saveAs')}>Save As…</button>
            <button type="button" className="media-doc-btn" onClick={() => setZoomOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function MediaDocCardList({ tools, content, cwd, onPromptAction, onOpenInIde }) {
  const targets = extractMediaDocTargets({ tools, content });
  if (!targets.length) return null;
  return (
    <div className="media-doc-list">
      {targets.map((t) => (
        <MediaDocCard key={t.path} target={t} cwd={cwd} onPromptAction={onPromptAction} onOpenInIde={onOpenInIde} />
      ))}
    </div>
  );
}

export default MediaDocCardList;
