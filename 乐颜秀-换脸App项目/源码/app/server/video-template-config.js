// A published managed template uses the exact, immutable preview file as its
// fusion source. Administrators cannot inject an external provider URL.
export function resolveVideoTemplate(templateId, catalog, configured, publicBase) {
  const item = catalog.templates.find((template) => template.id === templateId && template.enabled !== false && template.media === "video");
  if (!item) return null;
  if (configured[templateId] && !String(item.previewVideo || "").startsWith("/effects/uploads/")) return { ...configured[templateId] };
  if ((!configured[templateId] && !/^custom-video-[a-f0-9-]{36}$/.test(item.id))
    || item.mode !== "video-fusion"
    || !/^\/effects\/uploads\/[a-z0-9-]+\.mp4$/.test(item.previewVideo || "")
    || String(item.rightsReference || "").trim().length < 4) return null;
  const base = new URL(publicBase);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) return null;
  return {
    name: item.name,
    aliyunTemplateId: "",
    videoUrl: new URL(item.previewVideo, base.origin).href,
    maskKey: "",
    managed: true,
    rightsReference: item.rightsReference,
  };
}
