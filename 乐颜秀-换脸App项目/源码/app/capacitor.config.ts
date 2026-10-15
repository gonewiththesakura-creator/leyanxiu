import type { CapacitorConfig } from "@capacitor/cli";

const isDebugBuild = process.env.CAPACITOR_BUILD_VARIANT === "debug";

const config: CapacitorConfig = {
  appId: "com.yibohuaxia.leyanxiu",
  appName: "乐颜秀",
  webDir: "dist",
  server: {
    hostname: "localhost",
    androidScheme: "https",
  },
  android: {
    backgroundColor: "#000000",
    allowMixedContent: isDebugBuild,
  },
  plugins: {
    StatusBar: {
      overlaysWebView: false,
      style: "LIGHT",
      backgroundColor: "#000000",
    },
    Keyboard: {
      resize: "native",
    },
  },
};

export default config;
