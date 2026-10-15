import { useEffect, useState } from "react";
import { PLATFORMS, buildCaption } from "@/lib/growth";
import { refreshAssetUrl } from "@/lib/api";
import { X, Copy, Check, Share2, Music2, MessageCircle, Play, Video } from "lucide-react";
import { IS_NATIVE_APP, mediaFileName, saveNativeMedia, shareNativeMedia } from "@/lib/native";

const PLATFORM_ICONS: Record<string, React.ReactNode> = {
  douyin: <Music2 size={26} />,
  kuaishou: <Play size={26} />,
  channels: <Video size={26} />,
  wechat: <MessageCircle size={26} />,
  moments: <MessageCircle size={26} />,
};

export function ShareSheet({
  templateName,
  result,
  kind,
  assetId,
  onClose,
}: {
  templateName: string;
  result: string;
  kind: "video" | "image";
  assetId?: string;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState("wechat");
  const [copied, setCopied] = useState(false);
  const caption = buildCaption(selected, templateName);
  const platform = PLATFORMS.find((p) => p.id === selected)!;

  useEffect(() => {
    const handleNativeBack = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    document.addEventListener("leyanxiu:native-back", handleNativeBack);
    return () => document.removeEventListener("leyanxiu:native-back", handleNativeBack);
  }, [onClose]);

  const downloadVideo = async () => {
    const refreshed = assetId ? await refreshAssetUrl(assetId) : { url: result };
    if (IS_NATIVE_APP) {
      await saveNativeMedia(refreshed.url, templateName, kind, refreshed.contentType, refreshed.ext);
      return;
    }
    const a = document.createElement("a");
    a.href = refreshed.url;
    a.download = `乐颜秀-${await mediaFileName(templateName, kind, refreshed.url, { mimeType: refreshed.contentType, extensionHint: refreshed.ext })}`;
    a.click();
  };

  const doShare = async () => {
    if (IS_NATIVE_APP) {
      try {
        const refreshed = assetId ? await refreshAssetUrl(assetId) : { url: result };
        await shareNativeMedia({ url: refreshed.url, templateName, kind, mimeType: refreshed.contentType, extensionHint: refreshed.ext, text: caption });
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "系统分享暂时不可用");
      }
      return;
    }
    // 真实App：此处调用各平台分享SDK直接跳发布页（微信群聊则弹微信转发卡片）
    // 原型：复制文案 + 保存成片，模拟跳转
    try {
      await navigator.clipboard.writeText(caption);
      setCopied(true);
    } catch { /* 剪贴板不可用 */ }
    await downloadVideo();
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end bg-black/45 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className="max-h-[92%] overflow-y-auto rounded-t-[28px] bg-[#f5f5f7] p-5 pb-[max(24px,env(safe-area-inset-bottom))] text-[#1d1d1f]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-[22px] font-semibold">分享作品</h3>
          <button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-black/[.06]" aria-label="关闭分享">
            <X size={18} />
          </button>
        </div>

        <div className="mt-5 grid grid-cols-5 gap-1.5">
          {PLATFORMS.map((p) => {
            return (
              <button
                type="button"
                key={p.id}
                onClick={() => setSelected(p.id)}
                className={`relative flex min-w-0 flex-col items-center gap-1.5 ${selected === p.id ? "text-[#0071e3]" : "text-[#6e6e73]"}`}
              >
                <div className={`flex h-12 w-12 items-center justify-center rounded-[8px] bg-gradient-to-br text-white ${p.color} ${selected === p.id ? "ring-2 ring-[#0071e3] ring-offset-2" : ""}`}>
                  {PLATFORM_ICONS[p.id]}
                </div>
                <span className="w-full truncate text-center text-[11px] font-medium">{p.name}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-5 rounded-[8px] border border-black/[.06] bg-white p-4 shadow-sm">
          <p className="mb-2 text-xs font-medium text-[#86868b]">分享文案</p>
          <p className="text-sm leading-relaxed text-[#3a3a3c]">{caption}</p>
        </div>

        <button
          type="button"
          onClick={doShare}
          className={`mt-4 flex w-full items-center justify-center gap-2.5 rounded-[8px] py-3.5 text-base font-semibold text-white transition-all active:scale-[0.99] disabled:opacity-60 ${
            copied
              ? "bg-[#248a3d]"
              : "bg-[#0071e3] shadow-[0_8px_18px_rgba(0,113,227,.22)]"
          }`}
        >
          {copied ? (
            <><Check size={20} /> {IS_NATIVE_APP ? "已打开系统分享" : `文案已复制，作品已保存，去${platform.name}粘贴发布吧`}</>
          ) : IS_NATIVE_APP ? (
            <><Share2 size={20} /> 打开系统分享</>
          ) : (
            <><Copy size={20} /> 复制文案并保存作品</>
          )}
        </button>
        <p className="mt-3 text-center text-[11px] leading-relaxed text-[#86868b]">
          {IS_NATIVE_APP ? "系统将显示设备上可用的分享应用" : `保存后请在${platform.name}内自行发布`}
        </p>
      </div>
    </div>
  );
}
