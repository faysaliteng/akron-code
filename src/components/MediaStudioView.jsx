import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon.jsx';
import { MediaDocCard } from './MediaDocCard.jsx';

const STYLE_PRESETS = [
  { id: '', label: 'Auto' },
  { id: 'photorealistic cinematic studio lighting, 8k', label: 'Photorealistic' },
  { id: 'emerald cyberpunk neon futuristic dark obsidian aesthetic', label: 'Cyberpunk Neon' },
  { id: 'sleek modern UI design showcase mockup hero banner', label: 'UI / Web Hero' },
  { id: 'minimalist luxury vector emblem logo on clean background', label: 'Logo / Brand' },
  { id: '3D octane product render isometric studio', label: '3D Render' },
  { id: 'vibrant anime studio key visual artwork', label: 'Anime Art' },
];

export function MediaStudioView({ cwd = '', provider = null, focusPath = '', onOpenInIde, setNotice, setError }) {
  const [mode, setMode] = useState('image'); // 'image' | 'video' | 'library'
  const [imageModels, setImageModels] = useState([]);
  const [videoModels, setVideoModels] = useState([]);
  const [library, setLibrary] = useState([]);
  const [libraryDir, setLibraryDir] = useState('');

  // Image Studio state
  const [imgPrompt, setImgPrompt] = useState('');
  const [imgStyle, setImgStyle] = useState('');
  const [imgModel, setImgModel] = useState('auto');
  const [imgAspect, setImgAspect] = useState('16:9');
  const [imgFormat, setImgFormat] = useState('png');
  const [imgCount, setImgCount] = useState(1);

  // Video Studio state
  const [vidPrompt, setVidPrompt] = useState('');
  const [vidModel, setVidModel] = useState('auto');
  const [vidAspect, setVidAspect] = useState('16:9');
  const [vidDuration, setVidDuration] = useState(3);
  const [vidFormat, setVidFormat] = useState('mp4');
  const [vidSourceImage, setVidSourceImage] = useState('');

  // Library filters
  const [libFilter, setLibFilter] = useState('all'); // 'all' | 'image' | 'video' | 'project'
  const [searchQuery, setSearchQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const loadCatalog = useCallback(async () => {
    if (!window.autobot || typeof window.autobot.mediaStudioCatalog !== 'function') return;
    try {
      const res = await window.autobot.mediaStudioCatalog({ cwd, provider });
      if (res && res.ok) {
        setImageModels(res.imageModels || []);
        setVideoModels(res.videoModels || []);
        setLibrary(res.library || []);
        if (res.libraryDir) setLibraryDir(res.libraryDir);
      }
    } catch (_) {}
  }, [cwd, provider]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    if (focusPath) {
      if (/\.(mp4|webm|mov)$/i.test(focusPath)) setLibFilter('video');
      else setLibFilter('image');
    }
  }, [focusPath]);

  const handleGenerateImage = async () => {
    const prompt = imgPrompt.trim();
    if (!prompt) {
      if (setError) setError('Enter an image prompt first.');
      return;
    }
    if (!window.autobot || typeof window.autobot.mediaStudioGenerate !== 'function') return;
    setBusy(true);
    try {
      const res = await window.autobot.mediaStudioGenerate({
        kind: 'image',
        prompt,
        style: imgStyle,
        model: imgModel,
        aspect_ratio: imgAspect,
        format: imgFormat,
        count: imgCount,
        cwd,
        provider,
      });
      if (res && res.ok) {
        if (setNotice) setNotice(`Generated image with ${res.model || imgModel}`);
        await loadCatalog();
      } else if (setError) {
        setError((res && res.error) || 'Image generation failed');
      }
    } catch (e) {
      if (setError) setError((e && e.message) || String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateVideo = async () => {
    const prompt = vidPrompt.trim() || 'Smooth cinematic camera motion';
    if (!window.autobot || typeof window.autobot.mediaStudioGenerate !== 'function') return;
    setBusy(true);
    try {
      const res = await window.autobot.mediaStudioGenerate({
        kind: 'video',
        prompt,
        model: vidModel,
        aspect_ratio: vidAspect,
        duration_sec: vidDuration,
        format: vidFormat,
        image_path: vidSourceImage,
        cwd,
        provider,
      });
      if (res && res.ok) {
        if (setNotice) setNotice(`Generated ${vidFormat.toUpperCase()} video with ${res.model || vidModel}`);
        await loadCatalog();
      } else if (setError) {
        setError((res && res.error) || 'Video generation failed');
      }
    } catch (e) {
      if (setError) setError((e && e.message) || String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteItem = async (item) => {
    if (!window.autobot || typeof window.autobot.mediaStudioDelete !== 'function') return;
    try {
      await window.autobot.mediaStudioDelete({ id: item.id, path: item.path });
      setLibrary((prev) => prev.filter((x) => x.path !== item.path));
    } catch (_) {}
  };

  const filteredLibrary = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return (library || []).filter((item) => {
      if (libFilter === 'image' && item.kind !== 'image') return false;
      if (libFilter === 'video' && item.kind !== 'video') return false;
      if (libFilter === 'project' && !item.inCurrentProject) return false;
      if (q) {
        const hay = `${item.name || ''} ${item.prompt || ''} ${item.model || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [library, libFilter, searchQuery]);

  const imageChoices = useMemo(() => (library || []).filter((x) => x.kind === 'image'), [library]);

  return (
    <div className="panel media-studio-panel">
      <div className="media-studio-head">
        <div className="media-studio-title">
          <h2><Icon name="Palette" size={20} /> Images &amp; Video Studio</h2>
          <p>
            Dedicated AI image &amp; video studio (Grok, Imagen 3, Gemini Flash Image, GPT-Image-1, Cloudflare &amp; Flux, Veo 2, Sora) with persistent library{libraryDir ? ` · ${libraryDir}` : ''}
          </p>
        </div>
        <div className="media-doc-actions">
          <button
            type="button"
            className="media-doc-btn"
            onClick={() => window.autobot?.studioAction?.({ action: 'reveal_library' })}
            title="Open Media Library folder in Finder"
          >
            <Icon name="FolderOpen" size={12} /> Open Library Folder
          </button>
          <button type="button" className="media-doc-btn" onClick={loadCatalog}>
            <Icon name="Refresh" size={12} /> Refresh
          </button>
        </div>
      </div>

      <div className="media-studio-mode-tabs">
        <button type="button" className={'media-studio-mode-tab' + (mode === 'image' ? ' on' : '')} onClick={() => setMode('image')}>
          <Icon name="Camera" size={14} /> Image Studio
        </button>
        <button type="button" className={'media-studio-mode-tab' + (mode === 'video' ? ' on' : '')} onClick={() => setMode('video')}>
          <Icon name="Play" size={14} /> Video Studio
        </button>
        <button type="button" className={'media-studio-mode-tab' + (mode === 'library' ? ' on' : '')} onClick={() => setMode('library')}>
          <Icon name="Folder" size={14} /> Media Library ({library.length})
        </button>
      </div>

      {mode === 'image' && (
        <div className="media-studio-composer">
          <textarea
            value={imgPrompt}
            onChange={(e) => setImgPrompt(e.target.value)}
            placeholder="Describe any image to generate (hero banner, logo, UI concept, product photo, character art)…"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !busy) handleGenerateImage();
            }}
          />
          <div className="media-studio-presets">
            {STYLE_PRESETS.map((s) => (
              <button
                key={s.label}
                type="button"
                className={'cust-preset-pill' + (imgStyle === s.id ? ' cust-check-chip on' : '')}
                onClick={() => setImgStyle(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="media-studio-controls">
            <div className="media-studio-field">
              <label>Image Model (Grok / Gemini / OpenAI / Flux)</label>
              <select value={imgModel} onChange={(e) => setImgModel(e.target.value)}>
                {imageModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — {m.available ? `Available · ${m.badge}` : 'Needs API Key'}
                  </option>
                ))}
              </select>
            </div>
            <div className="media-studio-field">
              <label>Aspect Ratio</label>
              <select value={imgAspect} onChange={(e) => setImgAspect(e.target.value)}>
                <option value="16:9">16:9 Wide</option>
                <option value="1:1">1:1 Square</option>
                <option value="9:16">9:16 Portrait</option>
                <option value="4:3">4:3 Classic</option>
              </select>
            </div>
            <div className="media-studio-field">
              <label>Format</label>
              <select value={imgFormat} onChange={(e) => setImgFormat(e.target.value)}>
                <option value="png">PNG (Lossless)</option>
                <option value="webp">WebP (Compact)</option>
                <option value="jpg">JPG</option>
                <option value="svg">SVG Vector</option>
              </select>
            </div>
            <div className="media-studio-field">
              <label>Count</label>
              <select value={imgCount} onChange={(e) => setImgCount(Number(e.target.value))}>
                <option value={1}>1 Image</option>
                <option value={2}>2 Images</option>
                <option value={4}>4 Images</option>
              </select>
            </div>
            <button type="button" className="media-studio-gen-btn" disabled={busy} onClick={handleGenerateImage}>
              <Icon name="Sparkles" size={14} /> {busy ? 'Generating…' : 'Generate Image'}
            </button>
          </div>
        </div>
      )}

      {mode === 'video' && (
        <div className="media-studio-composer">
          <textarea
            value={vidPrompt}
            onChange={(e) => setVidPrompt(e.target.value)}
            placeholder="Describe the video scene or motion (or select an existing image below to animate it into video)…"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !busy) handleGenerateVideo();
            }}
          />
          <div className="media-studio-controls">
            <div className="media-studio-field">
              <label>Video Model (Veo 2 / Sora / Grok / Studio)</label>
              <select value={vidModel} onChange={(e) => setVidModel(e.target.value)}>
                {videoModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — {m.available ? `Available · ${m.badge}` : 'Needs API Key'}
                  </option>
                ))}
              </select>
            </div>
            <div className="media-studio-field">
              <label>Animate Source Image (Optional)</label>
              <select value={vidSourceImage} onChange={(e) => setVidSourceImage(e.target.value)}>
                <option value="">None (Text-to-Video)</option>
                {imageChoices.map((img) => (
                  <option key={img.id || img.path} value={img.path}>{img.name}</option>
                ))}
              </select>
            </div>
            <div className="media-studio-field">
              <label>Duration</label>
              <select value={vidDuration} onChange={(e) => setVidDuration(Number(e.target.value))}>
                <option value={2}>2 seconds</option>
                <option value={3}>3 seconds</option>
                <option value={5}>5 seconds</option>
                <option value={8}>8 seconds</option>
              </select>
            </div>
            <div className="media-studio-field">
              <label>Aspect Ratio &amp; Format</label>
              <select value={`${vidAspect}|${vidFormat}`} onChange={(e) => { const [a, f] = e.target.value.split('|'); setVidAspect(a); setVidFormat(f); }}>
                <option value="16:9|mp4">16:9 MP4 (H.264)</option>
                <option value="9:16|mp4">9:16 MP4 Vertical</option>
                <option value="1:1|mp4">1:1 MP4 Square</option>
                <option value="16:9|gif">16:9 Animated GIF</option>
              </select>
            </div>
            <button type="button" className="media-studio-gen-btn" disabled={busy} onClick={handleGenerateVideo}>
              <Icon name="Play" size={14} /> {busy ? 'Rendering Video…' : 'Generate Video'}
            </button>
          </div>
        </div>
      )}

      <div className="media-studio-library-bar">
        <div className="media-doc-tabs">
          {[
            { id: 'all', label: `All (${library.length})` },
            { id: 'image', label: `Images (${library.filter((x) => x.kind === 'image').length})` },
            { id: 'video', label: `Videos (${library.filter((x) => x.kind === 'video').length})` },
            ...(cwd ? [{ id: 'project', label: `Current Project (${library.filter((x) => x.inCurrentProject).length})` }] : []),
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={'media-doc-tab' + (libFilter === tab.id ? ' on' : '')}
              onClick={() => setLibFilter(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="media-studio-search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter by name, prompt, or model…"
        />
      </div>

      {filteredLibrary.length === 0 ? (
        <p className="muted">No images or videos in your library yet. Generate one above or ask Akron Code in chat — everything saves here automatically.</p>
      ) : (
        <div className="media-studio-grid">
          {filteredLibrary.map((item) => (
            <MediaDocCard
              key={item.id || item.path}
              target={{
                path: item.path,
                cachePath: item.cachePath,
                previewDataUrl: item.previewDataUrl,
                model: item.model,
                width: item.width,
                height: item.height,
                size: item.size,
                kind: item.kind,
              }}
              cwd={item.cwd || cwd}
              onOpenInIde={onOpenInIde}
              onAnimateImage={(fp) => {
                setVidSourceImage(fp);
                setMode('video');
              }}
              onDelete={() => handleDeleteItem(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default MediaStudioView;
