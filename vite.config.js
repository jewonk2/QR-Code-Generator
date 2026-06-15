import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages 배포 시 "https://사용자명.github.io/저장소이름/" 형태라면
// base를 "/저장소이름/"으로 설정해야 합니다.
// - 커스텀 도메인을 쓰거나 "사용자명.github.io" 저장소(루트 사이트)라면 "/" 로 두세요.
export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH || "/",
});
