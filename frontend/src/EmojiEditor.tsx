import { useEffect, useId, useRef, useState } from "react";
import { apiUrl, editImage, getImageUrl, type EmojiReady } from "./api";

export function EmojiEditor({ emoji, mode, onSave, onClose }: {
  emoji: EmojiReady; mode: "crop" | "text";
  onSave: (emoji: EmojiReady) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [crop, setCrop] = useState({x: 0, y: 0, width: 100, height: 100});
  const [text, setText] = useState(emoji.text || "");
  const [position, setPosition] = useState(emoji.position || "bottom");
  const [fontSize, setFontSize] = useState(emoji.font_size || 24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sourceId = mode === "text" ? emoji.text_source_id || emoji.image_id : emoji.source_id || emoji.image_id;
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function save() {
    setBusy(true); setError("");
    try {
      const result = await editImage({image_id: sourceId,
        ...(mode === "crop" ? {crop} : {}), text, position, font_size: fontSize});
      onSave({...result, source_id: mode === "text" ? emoji.source_id || sourceId : sourceId});
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="editor" onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
    <div className="editor-heading"><h2>{mode === "crop" ? "Crop image" : "Edit text"}</h2><button disabled={busy} onClick={onClose} aria-label="Close editor">×</button></div>
    {mode === "crop" ? <>
      <p>Adjust the selection to keep the part you want.</p>
      <div className="crop-image">
        <img src={getImageUrl(sourceId)} alt="Image to crop" onError={() => setError("This image has expired. Search again.")} />
        <div className="crop-selection" style={{left: `${crop.x}%`, top: `${crop.y}%`, width: `${crop.width}%`, height: `${crop.height}%`}} />
      </div>
      <div className="crop-controls">{(["x", "y", "width", "height"] as const).map((key) => <label key={key}>
        {{x:"Left", y:"Top", width:"Width", height:"Height"}[key]} <span>{crop[key]}%</span>
        <input type="range" min={key === "x" || key === "y" ? 0 : 1}
          max={key === "x" ? 100-crop.width : key === "y" ? 100-crop.height : key === "width" ? 100-crop.x : 100-crop.y}
          value={crop[key]} onChange={(e) => setCrop({...crop, [key]: Number(e.target.value)})} />
      </label>)}</div>
    </> : <div className="text-preview">
      <img src={getImageUrl(sourceId)} alt="Text preview" onError={() => setError("This image has expired. Search again.")} />
      <span className={`overlay-text ${position}`} style={{fontSize: fontSize * 2}}>{text}</span>
    </div>}
    <label>Text <input maxLength={40} value={text} onChange={(e) => setText(e.target.value)} placeholder="Optional label" /></label>
    <div className="text-options"><label>Position <select value={position} onChange={(e) => setPosition(e.target.value)}><option>bottom</option><option>center</option><option>top</option></select></label>
      <label>Size <input type="range" min="10" max="48" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} /></label></div>
    <p className="muted">Text is fitted to the final image. Review the saved preview before downloading.</p>
    {error && <p role="alert">{error}</p>}
    <div className="editor-actions"><button disabled={busy} onClick={onClose}>Cancel</button><button disabled={busy || !!error} onClick={save}>{busy ? "Saving…" : "Save edit"}</button></div>
  </dialog>;
}

function SlackReaction({ imageUrl }: { imageUrl: string }) {
  const tooltipId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);

  function hidePreview() {
    tooltip.current?.hidePopover();
  }

  function showPreview() {
    if (!trigger.current || !tooltip.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = 176;
    const height = 184;
    tooltip.current.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2))}px`;
    tooltip.current.style.top = `${rect.top >= height + 12 ? rect.top - height - 8 : Math.min(rect.bottom + 8, window.innerHeight - height - 8)}px`;
    tooltip.current.showPopover();
  }

  useEffect(() => {
    window.addEventListener("scroll", hidePreview, true);
    window.addEventListener("resize", hidePreview);
    return () => {
      window.removeEventListener("scroll", hidePreview, true);
      window.removeEventListener("resize", hidePreview);
    };
  }, []);

  return <div className="slack-preview" onMouseEnter={showPreview} onMouseLeave={hidePreview}>
    <span>In Slack</span>
    <button ref={trigger} type="button" className="slack-reaction"
      aria-label="Preview emoji at a larger size" aria-describedby={tooltipId}
      onFocus={showPreview} onBlur={hidePreview} onClick={showPreview}
      onKeyDown={(event) => { if (event.key === "Escape") { hidePreview(); event.stopPropagation(); } }}>
      <img src={imageUrl} alt="" /> <span>1</span>
    </button>
    <div ref={tooltip} id={tooltipId} className="slack-emoji-popover" popover="auto" role="tooltip">
      <img src={imageUrl} alt="Enlarged emoji preview" />
      <span>Custom emoji</span>
    </div>
  </div>;
}

export function EmojiCard({ emoji, disabled, onEdit }: {emoji: EmojiReady; disabled: boolean; onEdit: (mode: "crop" | "text") => void}) {
  const [failed, setFailed] = useState(false);
  return <div className="result-card">
    {failed ? <p role="status">Image unavailable. Search again to replace it.</p> : <>
      <div className="result-previews"><img className="large-preview" src={apiUrl(emoji.image_url)} alt="Edited emoji preview" onError={() => setFailed(true)} />
        <SlackReaction imageUrl={apiUrl(emoji.image_url)} />
      </div>
      <div className="result-actions"><a href={apiUrl(emoji.download_url)} download>Download PNG</a><button disabled={disabled} onClick={() => onEdit("text")}>Edit text</button><button disabled={disabled} onClick={() => onEdit("crop")}>Crop</button></div>
    </>}
  </div>;
}
