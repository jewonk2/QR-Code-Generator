# QR 코드 생성기

직접 구현한 QR 인코더(ISO/IEC 18004 기반)를 사용하는 React 앱입니다. 이 프로젝트를
GitHub에 올리고 GitHub Pages로 무료 호스팅하는 방법을 안내합니다.

## 1. GitHub 저장소(repository) 만들기

1. https://github.com 에 로그인 → 우측 상단 **+** → **New repository**
2. 저장소 이름 입력 (예: `qr-generator`)
   - 만약 `사용자명.github.io` 형태의 "메인 사이트" 저장소로 만들고 싶다면,
     저장소 이름을 정확히 `사용자명.github.io` 로 지정하세요.
3. Public(공개)으로 두고 **Create repository** 클릭

## 2. 코드 업로드

### 방법 A — 웹에서 드래그 앤 드롭 (Git 명령어 모름)
1. 새로 만든 저장소 페이지에서 **uploading an existing file** 클릭
2. 이 프로젝트 폴더 안의 모든 파일/폴더를 그대로 드래그해서 업로드
   - `.github` 폴더(숨김 폴더처럼 보일 수 있음)도 반드시 포함해야 합니다.
3. **Commit changes** 클릭

### 방법 B — Git 명령어 사용
```bash
cd qr-generator
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/사용자명/저장소이름.git
git push -u origin main
```

## 3. GitHub Pages 활성화

1. 저장소 → **Settings** → **Pages**
2. **Source**를 **GitHub Actions**로 선택
3. `main` 브랜치에 push하면 `.github/workflows/deploy.yml`이 자동으로 실행되어
   빌드 후 배포됩니다 (Actions 탭에서 진행 상황 확인 가능)
4. 배포 완료 후 다음 주소에서 접속 가능:
   - 저장소 이름이 `사용자명.github.io` 인 경우: `https://사용자명.github.io/`
   - 그 외 일반 저장소 이름인 경우: `https://사용자명.github.io/저장소이름/`

## 4. (선택) 나만의 도메인 연결하기

이미 구입한 도메인(예: `myqr.com`)이 있다면:

1. 저장소 루트에 `CNAME` 파일을 만들고 도메인 주소만 한 줄 입력
   ```
   myqr.com
   ```
   (또는 `public/CNAME`에 넣어도 빌드 시 dist로 복사됩니다)
2. 도메인 등록업체(가비아, 후이즈, Cloudflare, Namecheap 등) DNS 설정에서:
   - **루트 도메인**(`myqr.com`)을 쓰려면 A 레코드 4개 추가:
     ```
     185.199.108.153
     185.199.109.153
     185.199.110.153
     185.199.111.153
     ```
   - **서브도메인**(`www.myqr.com` 등)을 쓰려면 CNAME 레코드로
     `사용자명.github.io` 를 가리키게 설정
3. GitHub 저장소 → Settings → Pages → **Custom domain**에 도메인 입력 후 저장
4. DNS 전파(최대 24시간) 후 **Enforce HTTPS** 체크박스 활성화

도메인이 아직 없다면 가비아, Cloudflare Registrar, Namecheap 등에서 구입할 수 있습니다.

## 로컬에서 직접 실행해보기

```bash
npm install
npm run dev
```
