import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleAlert, RotateCcw } from "lucide-react";

interface State {
  failed: boolean;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("应用界面异常", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-[#f5f5f7] p-6 text-[#1d1d1f]">
        <section className="w-full max-w-sm rounded-[8px] bg-white p-6 text-center shadow-[0_18px_50px_rgba(0,0,0,.12)]">
          <CircleAlert size={38} className="mx-auto text-[#ff9500]" />
          <h1 className="mt-4 text-xl font-semibold">页面暂时没有正常显示</h1>
          <p className="mt-2 text-sm leading-6 text-[#6e6e73]">你的照片不会因为这个错误自动上传。重新打开页面即可继续。</p>
          <button type="button" onClick={() => window.location.reload()} className="mt-5 flex w-full items-center justify-center gap-2 rounded-[8px] bg-[#0071e3] py-3 text-base font-semibold text-white">
            <RotateCcw size={18} /> 重新打开
          </button>
        </section>
      </main>
    );
  }
}
