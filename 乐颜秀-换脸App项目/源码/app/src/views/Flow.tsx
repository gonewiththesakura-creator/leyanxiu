import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Template } from "@/data/templates";
import { SAMPLE_AVATARS, saveWork } from "@/data/templates";
import { generateCreation, getPublicCompliance, LOCAL_DEMO_MODE, recordCreationConsent, refreshAssetUrl, type CreationResult, type PublicCompliance } from "@/lib/api";
import {
  ArrowLeft, Camera, CheckCircle2, Images, ScanFace,
  Download, Share2, RotateCcw, ShieldCheck, Sparkles, Volume2, VolumeX,
} from "lucide-react";
import { ShareSheet } from "@/views/Share";
import { APP_ACCOUNT_ONLY, ACCOUNT_ONLY_NOTICE } from '@/lib/account-only';
import {
  IS_NATIVE_APP,
  isNativeCancellation,
  mediaFileName,
  saveNativeMedia,
  selectNativePhoto,
} from "@/lib/native";

/* ---------- 上传照片（适老化） ---------- */
export function UploadView({
  ...props
}: {
  template: Template;
  credits: number;
  onBack: () => void;
  onGenerate: (photo: string, targetAge?: number) => void;
  onPurchase: () => void;
}) {
  if (APP_ACCOUNT_ONLY) return <AccountTestCreationNotice onBack={props.onBack} />;
  return <EnabledUploadView {...props} />;
}

function AccountTestCreationNotice({ onBack }: { onBack: () => void }) {
  return <div className="flex h-full flex-col items-center justify-center bg-[#f5f5f7] px-6 text-center text-[#1d1d1f]">
    <p role="status" className="text-base leading-7">{ACCOUNT_ONLY_NOTICE}</p>
    <button type="button" onClick={onBack} className="mt-6 min-h-12 rounded-lg bg-[#0071e3] px-6 text-white">返回</button>
  </div>;
}

function EnabledUploadView({
  template,
  credits,
  onBack,
  onGenerate,
  onPurchase,
}: {
  template: Template;
  credits: number;
  onBack: () => void;
  onGenerate: (photo: string, targetAge?: number) => void;
  onPurchase: () => void;
}) {
  const [photo, setPhoto] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<"ok" | "fail" | null>(null);
  const [targetAge, setTargetAge] = useState(template.targetAge || 60);
  const [previewMuted, setPreviewMuted] = useState(false);
  const [previewSoundBlocked, setPreviewSoundBlocked] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [faceConsent, setFaceConsent] = useState(false);
  const [subjectAuthorization, setSubjectAuthorization] = useState<"self" | "authorized" | null>(null);
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  const [compliance, setCompliance] = useState<PublicCompliance | null>(null);
  const [complianceLoading, setComplianceLoading] = useState(!LOCAL_DEMO_MODE);
  const [complianceError, setComplianceError] = useState("");
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const isVideoTemplate = template.media === "video" && Boolean(template.previewVideo);
  const disclosedServices = (compliance?.aiServices || []).filter((service) => service.capabilities?.includes(template.mode));
  const disclosedSuppliers = disclosedServices.map((service) => `${service.provider}（${service.model}）`);
  const complianceReady = LOCAL_DEMO_MODE || (
    compliance?.status === "approved"
    && disclosedSuppliers.length > 0
    && Boolean(compliance.retention)
  );
  const sourceRetentionHours = compliance?.retention?.sourceHours;
  const retentionLabel = sourceRetentionHours
    ? `源照片最长保存 ${sourceRetentionHours} 小时，到期自动删除`
    : LOCAL_DEMO_MODE ? "演示模式不上传照片" : "保存期限尚未完成生产披露";

  useEffect(() => {
    if (LOCAL_DEMO_MODE) return;
    let active = true;
    setComplianceLoading(true);
    setComplianceError("");
    void getPublicCompliance()
      .then((result) => {
        if (active) setCompliance(result);
      })
      .catch((error) => {
        if (active) setComplianceError(error instanceof Error ? error.message : "合规信息读取失败");
      })
      .finally(() => {
        if (active) setComplianceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [template.mode]);

  useLayoutEffect(() => {
    const video = previewVideoRef.current;
    if (!video || !isVideoTemplate) return;
    let mounted = true;

    video.muted = false;
    video.volume = 1;
    void video.play().then(() => {
      if (!mounted) return;
      setPreviewMuted(false);
      setPreviewSoundBlocked(false);
    }).catch(() => {
      if (!mounted) return;
      video.muted = true;
      setPreviewMuted(true);
      setPreviewSoundBlocked(true);
      void video.play().catch(() => setPreviewError(true));
    });

    return () => {
      mounted = false;
      video.pause();
    };
  }, [isVideoTemplate, template.previewVideo]);

  const togglePreviewSound = () => {
    const video = previewVideoRef.current;
    if (!video) return;
    const nextMuted = previewSoundBlocked ? false : !previewMuted;
    setPreviewMuted(nextMuted);
    setPreviewSoundBlocked(false);
    video.muted = nextMuted;
    void video.play().catch(() => {
      video.muted = true;
      setPreviewMuted(true);
      setPreviewSoundBlocked(true);
    });
  };

  const runCheck = (src: string) => {
    setPhoto(src);
    setChecking(false);
    setCheckResult("ok");
    setFaceConsent(false);
    setSubjectAuthorization(null);
  };

  const normalizePhoto = (source: string) => new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (Math.min(width, height) < 256) {
        reject(new Error("照片分辨率太低，请选择更清晰的照片"));
        return;
      }
      const scale = Math.min(1, 2000 / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("照片读取失败，请换一张重试"));
        return;
      }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.92));
    };
    image.onerror = () => {
      reject(new Error("照片格式无法读取，请换一张重试"));
    };
    image.src = source;
  });

  const preparePhoto = async (file: File) => {
    if (!file.type.startsWith("image/")) throw new Error("请选择 JPG、PNG 或 WebP 照片");
    if (file.size > 20 * 1024 * 1024) throw new Error("照片不能超过 20MB");
    const objectUrl = URL.createObjectURL(file);
    try {
      return await normalizePhoto(objectUrl);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setChecking(true);
    setCheckResult(null);
    try {
      runCheck(await preparePhoto(file));
    } catch (error) {
      setChecking(false);
      setPhoto(null);
      setCheckResult("fail");
      window.alert(error instanceof Error ? error.message : "照片读取失败");
    }
  };

  const choosePhoto = async (source: "gallery" | "camera") => {
    if (!IS_NATIVE_APP) {
      (source === "camera" ? cameraRef : galleryRef).current?.click();
      return;
    }
    setChecking(true);
    setCheckResult(null);
    try {
      const selected = await selectNativePhoto(source);
      if (selected) runCheck(await normalizePhoto(selected));
    } catch (error) {
      setChecking(false);
      if (isNativeCancellation(error)) return;
      setPhoto(null);
      setCheckResult("fail");
      window.alert(error instanceof Error ? error.message : "照片读取失败");
    }
  };

  const chooseSample = async (src: string) => {
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error("示例照片加载失败");
      const blob = await response.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("示例照片读取失败"));
        reader.readAsDataURL(blob);
      });
      runCheck(dataUrl);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "示例照片加载失败");
    }
  };

  const startCreation = async () => {
    if (!photo || checkResult !== "ok" || !faceConsent || !subjectAuthorization || !complianceReady) return;
    setConsentSubmitting(true);
    try {
      await recordCreationConsent({
        suppliers: disclosedSuppliers,
        subjectAuthorization,
        purpose: `使用“${template.name}”功能生成${template.media === "video" ? "视频" : "图片"}作品`,
      });
      onGenerate(photo, template.agePicker ? targetAge : undefined);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "授权记录失败，请重试");
      setConsentSubmitting(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-[#f5f5f7]">
      <div className="flex items-center gap-3 px-5 pb-3 pt-6">
        <button type="button" onClick={onBack} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-[#1d1d1f] shadow-sm ring-1 ring-black/[.06]" aria-label="返回">
          <ArrowLeft size={21} />
        </button>
        <div>
          <p className="text-xs font-medium text-[#0071e3]">{template.name}</p>
          <h2 className="mt-0.5 text-[22px] font-semibold text-[#1d1d1f]">{isVideoTemplate ? "用我的照片制作" : "选择一张照片"}</h2>
        </div>

      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-4 pt-2">
        {isVideoTemplate && (
          <section onClick={() => { if (previewMuted || previewSoundBlocked) togglePreviewSound(); }} className="relative h-[286px] cursor-pointer overflow-hidden rounded-[8px] bg-black shadow-[0_16px_36px_rgba(0,0,0,.18)]" aria-label={`${template.name}模板预览`}>
            <img src={template.cover} alt={`${template.name}模板画面`} className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${previewReady && !previewError ? "opacity-0" : "opacity-100"}`} />
            {!previewError && (
              <video
                ref={previewVideoRef}
                src={template.previewVideo}
                poster={template.cover}
                muted={previewMuted}
                loop
                playsInline
                autoPlay
                disablePictureInPicture
                preload="auto"
                onPlaying={() => setPreviewReady(true)}
                onLoadedData={() => setPreviewReady(true)}
                onError={() => setPreviewError(true)}
                className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-300 ${previewReady ? "opacity-100" : "opacity-0"}`}
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/20" />
            <span className="absolute left-3 top-3 rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-md">AI 模板演示</span>
            <button type="button" onClick={(event) => { event.stopPropagation(); togglePreviewSound(); }} className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md" aria-label={previewMuted ? "开启模板声音" : "关闭模板声音"}>
              {previewMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            {previewSoundBlocked && <span className="absolute right-3 top-14 rounded-full bg-black/55 px-2.5 py-1 text-[10px] font-medium text-white backdrop-blur-md">点画面开声音</span>}
            <div className="absolute inset-x-4 bottom-4 text-white">
              <p className="text-[11px] font-medium text-white/70">{template.category}</p>
              <h3 className="mt-0.5 text-[21px] font-semibold">{template.name}</h3>
              <p className="mt-1 line-clamp-1 text-xs text-white/75">{template.description}</p>
            </div>
          </section>
        )}

        <div
          onClick={() => void choosePhoto("gallery")}
          className={`relative flex cursor-pointer flex-col items-center justify-center overflow-hidden rounded-[8px] border border-black/[.08] bg-white shadow-[0_14px_34px_rgba(0,0,0,.07)] ${isVideoTemplate ? "mt-4 min-h-[112px] p-4" : "aspect-[4/5]"}`}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void choosePhoto("gallery"); }}
        >
          {photo ? (
            isVideoTemplate ? (
              <div className="flex w-full items-center gap-4">
                <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-[8px] bg-[#f2f2f7]">
                  <img src={photo} alt="已选择的照片" className="h-full w-full object-cover" />
                  {checking && <div className="absolute inset-0 flex items-center justify-center bg-black/50"><ScanFace size={28} className="animate-pulse text-white" /></div>}
                </div>
                <div className="min-w-0 text-left">
                  <p className="flex items-center gap-2 text-base font-semibold text-[#1d1d1f]">
                    {checkResult === "ok" && <CheckCircle2 size={19} className="shrink-0 text-[#34c759]" />}
                    {checking ? "正在读取照片" : "照片已选好"}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-[#6e6e73]">点击这里可以从相册更换</p>
                </div>
              </div>
            ) : (
              <>
                <img src={photo} alt="已选择的照片" className="absolute inset-0 h-full w-full object-cover" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                {checking && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/55">
                    <ScanFace size={44} className="animate-pulse text-white" />
                    <p className="mt-3 text-base font-medium text-white/80">正在读取照片</p>
                  </div>
                )}
                {checkResult === "ok" && (
                  <div className="absolute bottom-4 left-4 right-4 rounded-[8px] bg-white/90 px-4 py-3 text-center shadow-lg backdrop-blur-xl">
                    <p className="flex items-center justify-center gap-2 text-base font-semibold text-[#1d1d1f]"><CheckCircle2 size={20} className="text-[#34c759]" /> 照片已读取，可以制作</p>
                    <p className="mt-1 text-xs text-[#6e6e73]">请确认正脸清晰无遮挡；点击照片可更换</p>
                  </div>
                )}
              </>
            )
          ) : (
            isVideoTemplate ? (
              <div className="flex w-full items-center gap-4 text-left">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[8px] bg-[#e8f2ff]">
                  <Images size={27} className="text-[#0071e3]" strokeWidth={1.8} />
                </div>
                <div className="min-w-0">
                  <p className="text-[17px] font-semibold text-[#1d1d1f]">选择你的正脸照片</p>
                  <p className="mt-1 text-xs leading-relaxed text-[#6e6e73]">选好后，人物会出现在上面的模板里</p>
                </div>
              </div>
            ) : (
              <>
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[#e8f2ff]">
                  <Images size={36} className="text-[#0071e3]" strokeWidth={1.8} />
                </div>
                <p className="mt-5 text-[20px] font-semibold text-[#1d1d1f]">从相册选择照片</p>
                <p className="mt-2 text-sm text-[#6e6e73]">支持手机相册和电脑本地图片</p>
              </>
            )
          )}
        </div>

        <input ref={galleryRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
        <input ref={cameraRef} type="file" accept="image/*" capture="user" className="hidden" onChange={handleFile} />

        <div className="mt-3 grid grid-cols-2 gap-3">
          <button type="button" onClick={() => void choosePhoto("gallery")} className="flex min-h-[48px] items-center justify-center gap-2 rounded-[8px] bg-[#0071e3] px-3 text-sm font-semibold text-white shadow-[0_7px_16px_rgba(0,113,227,.2)] active:scale-[.99]">
            <Images size={18} /> 从相册选择
          </button>
          <button type="button" onClick={() => void choosePhoto("camera")} className="flex min-h-[48px] items-center justify-center gap-2 rounded-[8px] border border-black/[.08] bg-white px-3 text-sm font-semibold text-[#1d1d1f] shadow-sm active:scale-[.99]">
            <Camera size={18} /> 直接拍照
          </button>
        </div>

        {template.agePicker && (
          <section className="mt-5 rounded-[8px] border border-black/[.08] bg-white p-4 shadow-sm" aria-labelledby="target-age-title">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h3 id="target-age-title" className="text-base font-semibold text-[#1d1d1f]">想看看哪个年龄</h3>
                <p className="mt-1 text-xs text-[#6e6e73]">一个功能，自由选择年龄效果</p>
              </div>
              <span className="shrink-0 text-[22px] font-semibold text-[#0071e3]">{targetAge} 岁</span>
            </div>
            <div className="mt-4 grid grid-cols-4 gap-2" role="radiogroup" aria-label="目标年龄">
              {[20, 40, 60, 80].map((age) => (
                <button
                  key={age}
                  type="button"
                  role="radio"
                  aria-checked={targetAge === age}
                  onClick={() => setTargetAge(age)}
                  className={`min-h-[44px] rounded-[8px] text-sm font-semibold transition ${targetAge === age ? "bg-[#0071e3] text-white shadow-[0_6px_14px_rgba(0,113,227,.22)]" : "bg-[#f2f2f7] text-[#3a3a3c]"}`}
                >
                  {age}岁
                </button>
              ))}
            </div>
          </section>
        )}

        {!photo && (
          <>
            <p className="mt-6 text-sm font-medium text-[#6e6e73]">示例照片</p>
            <div className="mt-3 flex gap-3">
              {SAMPLE_AVATARS.map((a) => (
                <img
                  key={a}
                  src={a}
                  alt="示例人像"
                  onClick={() => void chooseSample(a)}
                  className="h-20 w-20 cursor-pointer rounded-[8px] border border-black/[.08] object-cover shadow-sm active:scale-95"
                />
              ))}
            </div>
          </>
        )}

        {photo && checkResult === "ok" && (
          <section className="mt-5 rounded-[8px] border border-[#bdd8f3] bg-[#edf6ff] p-4 text-left" aria-labelledby="face-consent-title">
            <h3 id="face-consent-title" className="text-sm font-semibold text-[#1d1d1f]">上传前单独确认</h3>
            {complianceLoading ? (
              <p className="mt-2 text-xs leading-5 text-[#52677d]">正在读取影像处理规则…</p>
            ) : complianceReady ? (
              <div className="mt-2 text-xs leading-5 text-[#52677d]">
                <p>用途：生成“{template.name}”作品。</p>
                <p>处理者：{LOCAL_DEMO_MODE ? "仅本机演示，不上传" : disclosedSuppliers.join("、")}。</p>
                <p>期限：{retentionLabel}。生成作品的保存期限以隐私政策和作品页说明为准。</p>
                {disclosedServices.map((service) => (
                  <p key={`${service.provider}-${service.model}`} className="mt-1">{service.region} · {service.filingReference}</p>
                ))}
              </div>
            ) : (
              <p className="mt-2 rounded-[8px] bg-[#fff4e5] px-3 py-2 text-xs leading-5 text-[#8a5200]">
                {complianceError || "本功能的实际处理商、备案信息或保存期限尚未完成生产披露，已禁止上传。"}
              </p>
            )}
            <fieldset className="mt-3" disabled={!complianceReady}>
              <legend className="text-xs font-semibold text-[#1d1d1f]">照片主体授权</legend>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {[
                  ["self", "这是我本人"],
                  ["authorized", "已获本人授权"],
                ].map(([value, label]) => (
                  <label key={value} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-[8px] border px-3 text-xs font-semibold ${subjectAuthorization === value ? "border-[#0071e3] bg-white text-[#0071e3]" : "border-[#c8d8e8] bg-white/60 text-[#52677d]"}`}>
                    <input
                      type="radio"
                      name="subject-authorization"
                      value={value}
                      checked={subjectAuthorization === value}
                      onChange={() => setSubjectAuthorization(value as "self" | "authorized")}
                      className="accent-[#0071e3]"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className={`mt-3 flex gap-3 ${complianceReady ? "cursor-pointer" : "cursor-not-allowed opacity-55"}`}>
              <input
                type="checkbox"
                checked={faceConsent}
                disabled={!complianceReady || !subjectAuthorization}
                onChange={(event) => setFaceConsent(event.target.checked)}
                className="mt-0.5 h-5 w-5 shrink-0 accent-[#0071e3]"
              />
              <span>
                <span className="block text-sm font-semibold text-[#1d1d1f]">单独同意处理这张人脸照片</span>
                <span className="mt-1 block text-xs leading-5 text-[#52677d]">不同意不会上传，也不影响浏览本地模板；可在“我的-设置”随时撤回。</span>
              </span>
            </label>
          </section>
        )}

        <div className="mt-6 flex gap-3 rounded-[8px] border border-[#cce7d3] bg-[#f1fbf3] p-4">
          <ShieldCheck size={21} className="mt-0.5 shrink-0 text-[#248a3d]" />
          <p className="text-sm leading-relaxed text-[#3d6b48]">
            {retentionLabel}。
          </p>
        </div>
      </div>

      <div className="border-t border-black/[.06] bg-white/90 p-5 pb-[max(20px,env(safe-area-inset-bottom))] backdrop-blur-xl">
        {credits <= 0 && complianceReady && (
          <p className="mb-3 rounded-[8px] border border-[#ffd6a3] bg-[#fff8ed] px-4 py-2.5 text-center text-sm text-[#9a5b00]">
            制作次数不足，请先购买。<button type="button" onClick={onPurchase} className="ml-2 font-semibold underline">查看套餐</button>
          </p>
        )}
         <button
           type="button"
           disabled={credits <= 0 || !photo || checkResult !== "ok" || !faceConsent || !subjectAuthorization || !complianceReady || consentSubmitting}
          onClick={() => void startCreation()}
          className="w-full rounded-[8px] bg-[#0071e3] py-3.5 text-[17px] font-semibold text-white shadow-[0_8px_18px_rgba(0,113,227,.22)] active:scale-[0.99] disabled:bg-[#d2d2d7] disabled:text-white disabled:shadow-none"
        >
          {consentSubmitting ? "正在确认授权…" : credits > 0 ? `开始制作（剩余${credits}次）` : "开始制作"}
        </button>
      </div>
    </div>
  );
}

/* ---------- 生成中 ---------- */
function creationSteps(template: Template) {
  if (template.mode === "photo-restore") return ["正在检查老照片…", "正在修复细节…", "正在自然上色…", "马上就好…"];
  if (template.mode === "photo-age") return ["正在识别人像…", "正在重塑年龄特征…", "正在还原自然光影…", "马上就好…"];
  if (template.mode === "photo-effect") return ["正在分析照片…", "正在应用专属效果…", "正在校准细节光影…", "马上就好…"];
  if (template.animeStyle === "portrait") return ["正在分析面部特征…", "正在调整专业光影…", "正在生成头像…", "马上就好…"];
  if (template.animeStyle === "comic") return ["正在分析照片…", "正在绘制漫画线条…", "正在调整色彩光影…", "马上就好…"];
  if (template.mode === "photo-anime") return ["正在分析照片…", "正在绘制艺术笔触…", "正在调整色彩…", "马上就好…"];
  if (template.mode === "photo-bg") return ["正在分离人物…", "正在生成旅行场景…", "正在融合光影…", "马上就好…"];
  return ["正在识别人像…", "正在匹配动作画面…", "正在生成专属视频…", "马上就好…"];
}

export function GeneratingView({
  ...props
}: {
  template: Template;
  photo: string;
  onDone: (result: CreationResult) => void;
  onError: (message: string) => void;
}) {
  if (APP_ACCOUNT_ONLY) return <AccountTestCreationNotice onBack={() => props.onError(ACCOUNT_ONLY_NOTICE)} />;
  return <EnabledGeneratingView {...props} />;
}

function EnabledGeneratingView({
  template,
  photo,
  onDone,
  onError,
}: {
  template: Template;
  photo: string;
  onDone: (result: CreationResult) => void;
  onError: (message: string) => void;
}) {
  const [progress, setProgress] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);
  const doneRef = useRef(false);
  const steps = creationSteps(template);

  useEffect(() => {
    let p = 0;
    const timer = setInterval(() => {
      p += Math.random() * 4 + 1.5;
      if (p >= 100) {
        p = 100;
        clearInterval(timer);
      }
      setProgress(Math.floor(p));
      setStepIdx(Math.min(steps.length - 1, Math.floor(p / (100 / steps.length))));
    }, 180);

    // 有服务端时走真实换脸API；否则本地演示合成
    generateCreation(template, photo).then((r) => {
      setTimeout(() => {
        if (!doneRef.current) {
          doneRef.current = true;
          onDone(r);
        }
      }, 4200);
    }).catch((e) => {
      if (!doneRef.current) {
        doneRef.current = true;
        onError(e?.message || "生成服务暂不可用");
      }
    });
    return () => clearInterval(timer);
  }, [onDone, onError, photo, steps.length, template]);

  return (
    <div className="flex h-full flex-col items-center justify-center bg-[#f5f5f7] px-8">
      <div className="relative">
        <div className="h-36 w-36 overflow-hidden rounded-full border-4 border-white shadow-[0_16px_36px_rgba(0,0,0,.16)]">
          <img src={photo} alt="正在处理的人像" className="h-full w-full object-cover" />
        </div>
        <div className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-[#0071e3]" style={{ animationDuration: "1.2s" }} />
        <div className="absolute -bottom-2 -right-2 rounded-full bg-[#0071e3] p-3 text-white shadow-lg">
          <Sparkles size={18} />
        </div>
      </div>

      <p className="mt-9 text-[40px] font-semibold tabular-nums text-[#1d1d1f]">{progress}%</p>
      <p className="mt-2 h-6 text-base font-medium text-[#0071e3]">{steps[stepIdx]}</p>

      <div className="mt-6 h-2 w-full overflow-hidden rounded-full bg-[#d2d2d7]">
        <div
          className="h-full rounded-full bg-[#0071e3] transition-all duration-200"
          style={{ width: `${progress}%` }}
        />
      </div>

      <p className="mt-8 text-sm text-[#86868b]">请保持页面开启</p>
    </div>
  );
}

/* ---------- 结果页 ---------- */
export function ResultView({
  template,
  result,
  kind,
  assetId,
  onRestart,
  onFinish,
  onGoWorks,
}: {
  template: Template;
  result: string;
  kind: "video" | "image";
  assetId?: string;
  onRestart: () => void;
  onFinish: () => void;
  onGoWorks: () => void;
}) {
  const savedRef = useRef(false);
  const [showShare, setShowShare] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (LOCAL_DEMO_MODE && !savedRef.current) {
      savedRef.current = true;
      saveWork({ id: Date.now().toString(), templateName: template.name, image: result, kind, createdAt: Date.now() });
    }
  }, [kind, result, template.name]);

  const handleDownload = async () => {
    setSaving(true);
    try {
      const refreshed = assetId ? await refreshAssetUrl(assetId) : { url: result };
      if (IS_NATIVE_APP) {
        const saved = await saveNativeMedia(refreshed.url, template.name, kind, refreshed.contentType, refreshed.ext);
        if (saved) window.alert(`已保存到系统相册\n${saved.path}`);
        return;
      }
      const a = document.createElement("a");
      a.href = refreshed.url;
      a.download = `乐颜秀-${await mediaFileName(template.name, kind, refreshed.url, { mimeType: refreshed.contentType, extensionHint: refreshed.ext })}`;
      a.click();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const handleShare = () => setShowShare(true);

  return (
    <div className="flex h-full flex-col bg-[#f5f5f7]">
      <div className="flex-1 overflow-y-auto px-5 pt-6">
        <div className="text-center">
          <p className="inline-flex items-center gap-2 rounded-full bg-[#eaf8ed] px-4 py-2 text-sm font-semibold text-[#248a3d]">
            <CheckCircle2 size={18} /> 作品已完成
          </p>
        </div>
        <div className="relative mt-4 overflow-hidden rounded-[8px] border border-black/[.07] bg-white shadow-[0_18px_44px_rgba(0,0,0,.12)]">
          {kind === "video" ? (
            <video src={result} className="aspect-[3/4] w-full bg-black object-cover" controls autoPlay loop playsInline />
          ) : (
            <img src={result} alt={`${template.name}作品`} className="w-full" />
          )}
          <div className="absolute left-3 top-3 flex flex-col items-start gap-1.5">
            <span className="rounded-full bg-black/65 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur">AI 生成</span>
            <span className="rounded-full bg-black/50 px-3 py-1.5 text-[11px] font-medium text-white backdrop-blur">{template.name}</span>
          </div>
        </div>
        <p className="mt-3 text-center text-xs text-[#86868b]">作品已保存到个人影集，请勿移除作品中的 AI 生成标识</p>
      </div>

      <div className="space-y-3 border-t border-black/[.06] bg-white/90 p-5 pb-[max(20px,env(safe-area-inset-bottom))] backdrop-blur-xl">
        <button
          type="button"
          onClick={handleShare}
          className="flex w-full items-center justify-center gap-2.5 rounded-[8px] bg-[#0071e3] py-3.5 text-[17px] font-semibold text-white shadow-[0_8px_18px_rgba(0,113,227,.22)] active:scale-[0.99]"
        >
          <Share2 size={22} /> 发给亲朋好友看看
        </button>
        <div className="flex gap-3">
          <button type="button" disabled={saving} onClick={() => void handleDownload()} className="flex flex-1 items-center justify-center gap-2 rounded-[8px] border border-black/[.08] bg-white py-3 text-base font-medium text-[#1d1d1f] shadow-sm disabled:opacity-60">
            <Download size={18} /> {saving ? "保存中…" : IS_NATIVE_APP ? "保存到相册" : "保存"}
          </button>
          <button type="button" onClick={onRestart} className="flex flex-1 items-center justify-center gap-2 rounded-[8px] border border-black/[.08] bg-white py-3 text-base font-medium text-[#1d1d1f] shadow-sm">
            <RotateCcw size={18} /> 再做一个
          </button>
        </div>
        <button type="button" onClick={onGoWorks} className="w-full py-2 text-sm text-[#6e6e73]">
          查看我以前做的
        </button>
        <button type="button" onClick={onFinish} className="w-full rounded-[8px] border border-black/[.08] bg-white py-3 text-base font-semibold text-[#1d1d1f] shadow-sm">
          完成
        </button>
      </div>

      {showShare && (
        <ShareSheet
          templateName={template.name}
          result={result}
          kind={kind}
          assetId={assetId}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
}
