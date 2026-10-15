import { useCallback, useEffect, useState } from "react";
import { getMediaAssets, uploadMediaAsset, type MediaAsset } from "./api";

export function MediaLibrary({ kind, mp4Only = false, onSelect }: { kind?: "image" | "video"; mp4Only?: boolean; onSelect?: (url: string) => void }) {
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [maxBytes, setMaxBytes] = useState(12 * 1024 * 1024);
  const [rightsReference, setRightsReference] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [storageNote, setStorageNote] = useState("");
  const load = useCallback(async () => {
    setError("");
    try { const data = await getMediaAssets(); setItems(data.items); setMaxBytes(data.maxBytes); setStorageNote(data.storage?.note || ""); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "素材读取失败"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const upload = async (file?: File) => {
    if (!file) return;
    setError(""); setMessage("");
    if (!rightsConfirmed || !rightsReference.trim()) { setError("请先填写素材授权来源并确认使用权"); return; }
    if (mp4Only && file.type !== "video/mp4") { setError("新视频模板的制作源须使用 MP4 文件"); return; }
    if (file.size > maxBytes) { setError(`文件不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`); return; }
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("文件读取失败，请重新选择"));
        reader.readAsDataURL(file);
      });
      const asset = await uploadMediaAsset(file.name, dataUrl, rightsReference.trim());
      setItems((previous) => [asset, ...previous]);
      setMessage("素材已上传并验证。选择后应用到草稿，发布后才对用户生效。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "上传失败"); }
    finally { setBusy(false); }
  };
  const visible = items.filter((item) => (!kind || item.kind === kind) && (!mp4Only || item.mime === "video/mp4"));
  return <section className="admin-media-library">
    <label className="admin-field"><span>素材来源 / 授权记录</span><input maxLength={500} value={rightsReference} onChange={(event) => setRightsReference(event.target.value)} placeholder="例如：自制封面，或授权合同编号" /></label>
    <label className="admin-media-rights"><input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} />确认具备素材及涉及人物、音乐的相应使用授权</label>
    <div className="admin-media-toolbar"><label className="admin-secondary-button">{busy ? "正在上传和验证…" : "上传素材"}<input type="file" disabled={busy} accept={kind === "image" ? "image/jpeg,image/png,image/webp" : kind === "video" ? "video/mp4,video/webm" : "image/jpeg,image/png,image/webp,video/mp4,video/webm"} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} /></label><button type="button" className="admin-secondary-button" disabled={busy} onClick={() => void load()}>刷新素材</button></div>
    <p className="admin-muted">图片支持 JPG、PNG、WebP，视频支持 MP4、WebM；最大 {Math.round(maxBytes / 1024 / 1024)} MB。每次上传生成独立素材，不覆盖已发布文件。</p>
    {storageNote && <p className="admin-muted">{storageNote}</p>}
    {error && <p className="admin-form-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <div className="admin-media-grid">{visible.map((asset) => <article className="admin-media-card" key={asset.id}>
      {asset.kind === "video" ? <video src={asset.url} controls playsInline preload="metadata" /> : <img src={asset.url} alt={asset.name} loading="lazy" />}
      <strong title={asset.name}>{asset.name}</strong><small>{asset.width} × {asset.height} · {(asset.size / 1024 / 1024).toFixed(1)} MB</small>
      {onSelect && <button type="button" className="admin-secondary-button" onClick={() => onSelect(asset.url)}>使用此素材</button>}
    </article>)}</div>
    {!visible.length && !error && <p className="admin-muted">暂无{kind === "video" ? "视频" : kind === "image" ? "图片" : ""}素材，请先上传。</p>}
  </section>;
}

export function MediaField({ label, value, kind = "image", mp4Only = false, onChange }: { label: string; value: string; kind?: "image" | "video"; mp4Only?: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  return <div className="admin-field admin-field-wide admin-media-field">
    <label><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} /></label>
    <div className="admin-media-field-preview">{value && (kind === "video" ? <video key={value} src={value} controls playsInline preload="metadata" /> : <img src={value} alt={label} />)}<button type="button" className="admin-secondary-button" onClick={() => setOpen((previous) => !previous)}>{open ? "收起素材库" : "上传 / 从素材库选择"}</button></div>
    {open && <MediaLibrary kind={kind} mp4Only={mp4Only} onSelect={(url) => { onChange(url); setOpen(false); }} />}
  </div>;
}
