# DSH 채팅 / 작업 이중 모드 — 한국어판

저장소: <https://github.com/artists2/dsh-chat-mode-ko> · 라이선스: MIT

**DeepSeek Harness(DSH) 데스크톱**용 서드파티 플러그인입니다. 같은 화면에서 「채팅」과 「작업」 두 모드를 버튼 하나로 전환하고, 채팅 모드는 DeepSeek 공식 웹 채팅을 내장해 **토큰을 쓰지 않습니다**.

> **비공식 안내**: 개인이 만든 서드파티 플러그인이며 DeepSeek 공식 제품이 아닙니다.
> 사용 전에 DeepSeek 이용 약관을 직접 확인하세요. 사용으로 생기는 계정/데이터 위험은 사용자 책임입니다.
> **원본**: [Starp1ume/dsh-chat-mode](https://github.com/Starp1ume/dsh-chat-mode) (MIT, v0.2.0-beta.2) 를 한국어 UI 로 옮긴 파생 저작물입니다. 자세한 출처와 변경 내역은 [NOTICE.md](NOTICE.md) 를 보세요.

## 기능

- **채팅 / 작업 모드 전환** — 제목 표시줄의 기본 메뉴 오른쪽에 `채팅 / 작업` 분할 버튼이 있고 두 모드에서 모두 보입니다. 기본 시작 모드는 채팅입니다.
- **채팅 모드는 토큰을 쓰지 않습니다** — DSH 데스크톱에 내장된 Electron webview 로 DeepSeek 공식 웹 채팅(기본 `https://chat.deepseek.com`) 을 띄웁니다. 로그인과 사용은 웹페이지에서 직접 합니다. DSH 는 채팅 모드에서 API 를 호출하지 않고 에이전트 루프도 돌리지 않습니다.
- **작업 모드 = DSH 기본 화면** — 기존 에이전트/코드 화면 그대로이며, API 를 호출하는 것은 이 모드뿐입니다.
- **작업으로 가져오기 (입력만, 전송 안 함)** — 채팅 웹페이지에서 텍스트를 선택하고 제목 표시줄의 `작업으로 가져오기` 를 누르면, 고정 스크립트가 선택한 텍스트만 읽고(사용자가 누르고 페이지가 공식 사이트일 때만) 작업 모드로 전환해 상단 안내 띠를 보여 줍니다. **자동 전송은 하지 않습니다.** 매번 대상 세션을 직접 고르며, 다른 세션으로 옮기거나 새 세션을 만들면 한 번 자동으로 채워집니다. 초안은 메모리에만 있고 최대 10분 뒤 사라집니다. 선택한 텍스트가 없거나 읽기에 실패하면 기존 붙여넣기 대화상자로 돌아가고, 20000자를 넘으면 잘라서 알립니다.
- **로그인 자동 기억 (실험적, 기본 켜짐)** — 공식 채팅 페이지에서 로그인하면 `localStorage.userToken` **한 항목만** 저장하고 다음 실행 때 되돌려 써서 로그인 상태를 복원합니다. 쿠키도, 다른 저장소도, 페이지 내용도 읽지 않습니다. 끄거나 `로그인 끄고 삭제` 를 누르면 저장이 멈추고 사본이 지워집니다.
- **한국어 UI** — 원본의 중국어 문자열을 모두 한국어로 옮겼습니다. 설정 페이지, 진단 패널, 안내 띠, 토스트, 오류 메시지까지 한국어입니다. 한국어 UI 로케일에서 제목 표시줄의 사이드바 버튼(`사이드바 접기` / `사이드바 열기` / `새 세션`)도 채팅 모드에서 올바르게 숨겨집니다.

## 설치

### 1) GitHub 에서 바로 설치

```powershell
dsh plugin --profile desktop add github:artists2/dsh-chat-mode-ko
```

버전을 고정하려면 뒤에 태그를 붙입니다.

```powershell
dsh plugin --profile desktop add github:artists2/dsh-chat-mode-ko#v0.2.0-ko.1
```

### 2) 이 폴더로 설치 (개발용)

DSH 대화에서 `plugin_manager` 의 `install_bundle` 에 이 디렉터리 절대 경로를 넘깁니다. 링크 설치라 파일을 고치면 바로 반영됩니다(플러그인을 껐다 켜거나 페이지를 새로 고치면 재적용).

### 기존 중국어판에서 옮기는 경우

이 번들의 [cordis.patch.yml](cordis.patch.yml) 이 원본 행(`chat-mode`)을 자동으로 끄고 한국어판 행(`chat-mode-ko`)을 추가합니다. 토글이 두 개 보이면 두 행이 동시에 살아 있다는 뜻이니 패치 적용 결과를 확인하세요.

원본이 설치되어 있지 않다면 "대상 행을 찾지 못했다"는 경고가 한 번 날 수 있습니다. 설치와 동작에는 영향이 없고, 그 경고는 이 번들이 원본을 끄려 하기 때문에 생기는 것입니다.

## 설정

설정 → **채팅 모드** 에서 바꿀 수 있습니다.

- 기본 시작 모드(`채팅` / `작업`) 와 `마지막 사용 모드 기억`
- 웹 주소 — https 만 허용. `deepseek.com` 과 하위 도메인은 바로 저장되고, 다른 도메인은 한 번 더 확인해야 합니다. 사용자 이름/비밀번호가 들어간 주소는 거부됩니다.
- `작업으로 가져오기` 템플릿
- 로그인 자동 기억 켜기/끄기, 지금 저장, 끄고 삭제

## 개인정보 / 보안

- 채팅 모드에서 이 플러그인은 네트워크 요청을 하지 않습니다. `fetch` / `XHR` / `WebSocket` / `sendBeacon` / `window.open` 이 코드에 없습니다.
- `executeJavaScript` 는 두 가지 고정 스크립트에만 씁니다. 로그인 복원(`localStorage.userToken` 읽기/쓰기)과 `작업으로 가져오기`(`window.getSelection().toString()` 읽기)입니다.
- 플러그인 저장소는 자체 localStorage 키 두 개뿐입니다. `dsh-chat-mode:prefs:v1`(설정/템플릿), `dsh-chat-mode:login:v1`(userToken 한 항목, 평문).
- 읽은 선택 텍스트는 메모리에만 두고 채운 뒤 바로 버립니다. 어디에도 저장하거나 전송하지 않습니다.

## 원본과 다른 점

| 항목 | 원본 | 이 저장소 |
| --- | --- | --- |
| UI 언어 | 중국어 | 한국어 (문자열 192개 치환) |
| 사이드바 버튼 숨김 | 중국어/영어 `aria-label` | + 한국어 `aria-label` 추가 |
| 패키지 이름 | `@starplume/dsh-chat-mode` | `@local/dsh-chat-mode-ko` |
| 모듈 / 슬롯 id | `@starplume/dsh-chat-mode`, `chat-mode` | `@local/dsh-chat-mode-ko`, `chat-mode-ko` |
| 원본 행 처리 | — | 이 번들이 원본 행을 비활성화 |
| 코드 주석 | 중국어 | 중국어 유지 (동작 로직은 원본과 동일) |

## 문구를 고치거나 다른 언어판을 만들 때

`tools/` 에 번역에 쓴 스크립트가 들어 있습니다.

- `tools/extract-cjk.mjs` — JS 파일에서 CJK 가 들어간 문자열 리터럴을 뽑아 JSON 으로 저장
- `tools/ko-map.json` — 중국어 → 한국어 대응표 192쌍
- `tools/apply-ko.mjs` — 대응표를 `client.js` 에 적용하고, 남은 문자열과 개수를 보고

```powershell
node tools/extract-cjk.mjs client.js strings.json
node tools/apply-ko.mjs client.js tools/ko-map.json
```

## 라이선스

MIT. 원본 저작권 고지는 [LICENSE](LICENSE) 를 따릅니다.

- 원본: https://github.com/Starp1ume/dsh-chat-mode (MIT, Copyright (c) 2026 Starp1ume)
- 아이콘 `icon.svg`: 원본 저장소의 것을 그대로 사용합니다.
- 번역 및 파생 작업: 이 저장소 기여자